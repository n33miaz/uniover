"""Limpeza da TV: fecha os apps abertos e libera memória pelo ADB, sem derrubar o controle.

O pedido do dono é "fechar tudo e limpar a memória **sem nos desconectar**". Por isso o
procedimento só usa o que o usuário `shell` pode fazer e nunca toca no que mantém o agente
conectado: o serviço do controle remoto (a sessão Remote v2), o próprio ADB e a rede. Nada de
`kill-server`, `disconnect`, `reboot`, `pm clear`/`uninstall`/`disable` nem `drop_caches` (exige
root). `pm trim-caches` também fica de fora: ele libera armazenamento, não RAM.

Sequência (cada passo é um comando curto e fixo, com a trava do ADB tomada só durante ele):

1. lê `MemAvailable` (o "antes");
2. descobre o que proteger (tela inicial, teclado, acessibilidade) e o que está rodando;
3. tecla HOME, para o app da frente virar "de fundo";
4. `am kill-all` (só processos de fundo e em cache);
5. `am force-stop` de cada app **em execução** que não esteja protegido;
6. lê `MemAvailable` de novo (o "depois").

Só se fecha o que está rodando, e só isso conta em `closed_apps`: um `force-stop` num app parado não
libera nada e ainda o deixa sem alarmes e sem avisos até a próxima abertura.

**Falha fecha a porta**: se não deu para ler a tela inicial, o teclado, a acessibilidade ou os
processos, nenhum app é fechado (ler errado não pode virar "nada a proteger"). Perdeu o ADB no meio:
para ali e relata. Passou do orçamento de tempo: o resto é pulado. Em todos os casos o resultado diz
o que não foi feito.
"""

import logging
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass, field
from typing import Any, Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.adb_commands import SEND_FAILED
from uniover_agent.core.tv.apps import is_user_app
from uniover_agent.core.tv.handlers import failed_result
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import (
    AdbError,
    AdbNotReady,
    AdbTimeout,
    Clock,
    Transport,
    TransportError,
    TvAdbCleanup,
)

_log = logging.getLogger(__name__)

CLEANUP_IN_PROGRESS: Final = "cleanup_in_progress"
CLEANUP_FAILED: Final = "cleanup_failed"

# Tempo que a limpeza se dá para agir (depois dele o que falta é pulado). Cada comando do ADB ainda
# pode levar o tempo-limite dele (5 s) e a leitura final outro tanto: o pior caso fica abaixo dos
# 30 s que a API espera.
DEFAULT_BUDGET_SECONDS: Final = 15.0
# Pausa depois de HOME (o app da frente precisa ir para o fundo) e antes de ler a memória final (o
# sistema leva um instante para devolver as páginas dos processos encerrados).
DEFAULT_SETTLE_SECONDS: Final = 1.0

# --- o que nunca se fecha -----------------------------------------------------------------------
# Além disto: o que a tela de apps esconde como peça do sistema (`apps.is_user_app`: `com.tcl.*`,
# `com.mediatek.*`, `com.droidlogic.*`, assistentes de configuração...), a tela inicial, o teclado
# em uso e os serviços de acessibilidade (lidos da própria TV a cada limpeza) e o que o dono listar
# em `tv_cleanup_keep`.

PROTECTED_PACKAGES: Final = frozenset(
    {
        # Serviço do controle remoto (Remote v2, portas 6466/6467): é a sessão do agente com a TV.
        # Fonte: `tv.ps1 reparar` do projeto da TV do dono (`$PKG`), medido na TV real.
        "com.google.android.tv.remote.service",
        # Framework e interface do sistema.
        "android",
        "com.android.systemui",
        # Configurações (`com.android.tv.settings` é o que a TV real lista; confirmado na amostra
        # colhida dela). A variante de celular entra por precaução.
        "com.android.tv.settings",
        "com.android.settings",
        # Serviços do Google Play e da estrutura de serviços: tudo depende deles.
        "com.google.android.gms",
        "com.google.android.gsf",
        # Recomendações do lançador: sem ele a tela inicial fica vazia até reiniciar.
        "com.google.android.tvrecommendations",
    }
)
PROTECTED_PREFIXES: Final = ("com.android.providers.",)
# Nome com `remote` não se fecha: não há como confirmar, sem a TV, todas as variantes do serviço do
# controle remoto (não confirmado além do pacote acima), então protege-se pelo nome. Custa, no
# máximo, um app de controle remoto que continua aberto.
PROTECTED_FRAGMENTS: Final = ("remote",)


def is_protected(package: str, extra: Collection[str] = ()) -> bool:
    """Este pacote nunca é fechado? `extra` são os pacotes lidos da TV e a lista do dono."""
    if package in extra or package in PROTECTED_PACKAGES:
        return True
    lowered = package.lower()
    if lowered.startswith(PROTECTED_PREFIXES) or any(f in lowered for f in PROTECTED_FRAGMENTS):
        return True
    # Peça do sistema da TV (a mesma regra que a lista de apps usa para esconder).
    return not is_user_app(package)


@dataclass(frozen=True, slots=True)
class CleanupReport:
    """O que a limpeza fez. Memória em MB (`None` quando não deu para ler)."""

    closed_apps: int
    memory_before_mb: int | None
    memory_after_mb: int | None
    failed_steps: tuple[str, ...]

    @property
    def freed_mb(self) -> int | None:
        """Quanto a memória disponível subiu; nunca negativo (algo pode ter aberto no meio)."""
        if self.memory_before_mb is None or self.memory_after_mb is None:
            return None
        return max(0, self.memory_after_mb - self.memory_before_mb)


@dataclass(slots=True)
class _Run:
    failed: list[str] = field(default_factory=list)
    # O ADB deixou de responder: nenhum passo seguinte é tentado.
    halted: bool = False

    def fail(self, step: str) -> None:
        if step not in self.failed:
            self.failed.append(step)


@dataclass(frozen=True, slots=True)
class _Outcome[T]:
    ok: bool
    value: T | None = None


class TvCleanup:
    """A sequência da limpeza. Uma por vez: o pedido que chega com outra rodando é recusado."""

    def __init__(
        self,
        adb: TvAdbCleanup,
        clock: Clock,
        *,
        keep: Collection[str] = (),
        budget_seconds: float = DEFAULT_BUDGET_SECONDS,
        settle_seconds: float = DEFAULT_SETTLE_SECONDS,
    ) -> None:
        self._adb = adb
        self._clock = clock
        self._keep = frozenset(keep)
        self._budget = budget_seconds
        self._settle = settle_seconds
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    async def run(self) -> CleanupReport:
        """Limpa a TV. Levanta `TvSessionError` se o ADB não respondeu ao primeiro comando (nada foi
        feito) ou se já há uma limpeza em andamento."""
        if self._running:
            raise TvSessionError(CLEANUP_IN_PROGRESS, "Já há uma limpeza em andamento.")
        self._running = True
        try:
            return await self._clean()
        finally:
            self._running = False

    async def _clean(self) -> CleanupReport:
        deadline = self._clock.monotonic() + self._budget
        run = _Run()
        # O primeiro comando é também o teste do canal: sem ADB não há limpeza, e o dono recebe o
        # motivo no lugar de um relatório vazio.
        try:
            before = await self._adb.memory_available_mb()
        except AdbError as exc:
            raise TvSessionError(exc.code, exc.message) from None

        candidates = await self._closable(run)
        await self._attempt(run, "go-home", self._adb.go_home)
        if not run.halted:
            await self._clock.sleep(self._settle)
        if not self._out_of_time(run, deadline):
            await self._attempt(run, "kill-background", self._adb.kill_background)

        closed = 0
        for package in candidates:
            if self._out_of_time(run, deadline):
                break
            stopped = await self._attempt(
                run, f"force-stop:{package}", self._adb.force_stop, package
            )
            if stopped.ok:
                closed += 1

        after: int | None = None
        if not run.halted:
            await self._clock.sleep(self._settle)
            after = (await self._attempt(run, "memory-after", self._adb.memory_available_mb)).value
        report = CleanupReport(closed, before, after, tuple(run.failed))
        _log.info(
            "limpeza da TV: %d apps fechados, memória %s -> %s MB, %d etapas falharam",
            report.closed_apps,
            before,
            after,
            len(report.failed_steps),
        )
        if report.failed_steps:
            _log.warning("etapas da limpeza que falharam: %s", ", ".join(report.failed_steps))
        return report

    async def _closable(self, run: _Run) -> list[str]:
        """Apps em execução que podem ser fechados; vazio se algo que protege não pôde ser lido."""
        apps = await self._attempt(run, "list-apps", self._adb.list_apps)
        home = await self._attempt(run, "read-protected", self._adb.home_packages)
        keyboard = await self._attempt(run, "read-protected", self._adb.input_method_package)
        access = await self._attempt(run, "read-protected", self._adb.accessibility_packages)
        running = await self._attempt(run, "read-running", self._adb.running_packages)
        if (
            apps.value is None
            or home.value is None
            or access.value is None
            or running.value is None
            or not keyboard.ok
        ):
            return []
        shielded = {*self._keep, *home.value, *access.value}
        if keyboard.value is not None:
            shielded.add(keyboard.value)
        return [
            app.package
            for app in apps.value
            if app.package in running.value and not is_protected(app.package, shielded)
        ]

    def _out_of_time(self, run: _Run, deadline: float) -> bool:
        if run.halted:
            return True
        if self._clock.monotonic() < deadline:
            return False
        run.fail("deadline")
        return True

    @staticmethod
    async def _attempt[T](
        run: _Run, step: str, action: Callable[..., Awaitable[T]], *args: Any
    ) -> _Outcome[T]:
        """Um passo: falha de um comando é registrada e a limpeza segue; falta do ADB, não."""
        if run.halted:
            return _Outcome(False)
        try:
            return _Outcome(True, await action(*args))
        except AdbNotReady, AdbTimeout:
            run.fail(step)
            run.fail("adb-lost")
            run.halted = True
        except AdbError:
            run.fail(step)
        return _Outcome(False)


def tv_cleanup_handler(
    cleanup: TvCleanup, transport: Transport, envelopes: EnvelopeFactory
) -> Handler:
    """`tv.cleanup.v1`: limpa a TV, manda `tv.cleanup.result.v1` e só depois responde ao comando.

    A ordem importa: a API junta o relatório ao pedido pelo `requestId` assim que o resultado do
    comando chega, e o canal entrega os quadros em ordem. Nunca levanta: erro inesperado vira
    resposta com código estável, sem texto da exceção.
    """

    async def handle(command: Command) -> CommandResult:
        request_id = command.body.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'requestId' ausente")
        try:
            report = await cleanup.run()
        except TvSessionError as exc:
            return failed_result(command, exc)
        except Exception:
            _log.exception("falha inesperada na limpeza da TV")
            return CommandResult(
                command.id,
                ResultStatus.FAILED,
                "A limpeza da TV falhou por um erro inesperado.",
                CLEANUP_FAILED,
            )
        try:
            await transport.send(
                envelopes.tv_cleanup_result(
                    request_id,
                    command.id,
                    closed_apps=report.closed_apps,
                    memory_before_mb=report.memory_before_mb,
                    memory_after_mb=report.memory_after_mb,
                    freed_mb=report.freed_mb,
                    failed_steps=report.failed_steps,
                )
            )
        except TransportError:
            return CommandResult(
                command.id,
                ResultStatus.FAILED,
                "não consegui enviar o relatório à API",
                SEND_FAILED,
            )
        return CommandResult(command.id, ResultStatus.OK)

    return handle
