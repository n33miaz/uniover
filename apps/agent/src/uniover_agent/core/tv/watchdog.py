"""Vigia do serviço do controle remoto da Android TV: religa por ADB quando ele morre.

O que já existe não é refeito aqui. A sessão (`TvSessionManager`) reabre o canal, o `TvRelocator`
procura a TV se o endereço mudou e o adaptador do Remote v2 fecha a sessão de uma TV que parou de
responder. O que faltava é **religar o serviço** quando ele morre (a TV da casa tem um limpador de
memória que o mata várias vezes ao dia, e sem ele as portas 6466/6467 ficam fechadas até alguém
mexer na TV). Isso é o que a tarefa agendada do PC fazia; agora vive dentro do agente.

Gentil com a TV: **não há sondagem própria**. O vigia só age quando alguém o avisa de uma porta
**recusada** (a TV está na rede e o serviço não atende): o `TvRelocator`, na conferência de um
minuto que já faz enquanto não há sessão, ou o gerenciador de sessão, se a conexão chegar a ser
recusada. Cada aviso vira, no máximo, duas conexões TCP para confirmar e, se for preciso, o reparo,
com no máximo 3 tentativas e depois um descanso.

Nada aqui pode derrubar o agente: o laço captura tudo o que não é cancelamento, e a sessão nunca
fica presa em "reparando" (`finally` e um tempo máximo para o reparo inteiro).
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Final

from uniover_agent.core.tv.session import SessionState, TvSessionManager
from uniover_agent.core.tv.watchdog_events import WatchdogEvents
from uniover_agent.ports import AdbNotReady, AdbUnauthorized, AdbUnavailable, Clock

_log = logging.getLogger(__name__)

# Depois de uma sequência que não religou o serviço, nada de nova sequência por este tempo.
DEFAULT_COOLDOWN_SECONDS: Final = 600.0
# Sem autorização no ADB (ou sem o `adb` no PC) não se resolve sozinho: descansa bem mais.
ADB_COOLDOWN_SECONDS: Final = 3600.0
# A primeira tentativa é na hora (os comandos já estão sendo recusados enquanto se repara); as
# seguintes esperam estes tempos.
DEFAULT_RETRY_WAITS: Final = (15.0, 45.0)
# Quanto esperar o serviço subir antes de conferir as portas de novo.
DEFAULT_SETTLE_SECONDS: Final = 3.0
# Teto do reparo inteiro (conexão ADB, comandos e esperas): passou disso, a sessão é liberada.
DEFAULT_BUDGET_SECONDS: Final = 240.0

# `True`: as portas atendem; `False`: a TV está na rede e recusa; `None`: não responde (standby).
PortsOpen = Callable[[], Awaitable[bool | None]]
RestartService = Callable[[], Awaitable[None]]


class TvWatchdog:
    def __init__(  # noqa: PLR0913 - cada argumento é uma injeção ou um limite, todos por nome
        self,
        clock: Clock,
        manager: TvSessionManager,
        ports_open: PortsOpen,
        restart_service: RestartService,
        events: WatchdogEvents,
        *,
        cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS,
        adb_cooldown_seconds: float = ADB_COOLDOWN_SECONDS,
        retry_waits: tuple[float, ...] = DEFAULT_RETRY_WAITS,
        settle_seconds: float = DEFAULT_SETTLE_SECONDS,
        budget_seconds: float = DEFAULT_BUDGET_SECONDS,
    ) -> None:
        """`ports_open` diz se as portas 6466 e 6467 atendem (ver `PortsOpen`); `restart_service`
        religa o serviço pelo ADB (levanta `AdbError` se não deu)."""
        self._clock = clock
        self._manager = manager
        self._ports_open = ports_open
        self._restart = restart_service
        self._events = events
        self._cooldown = cooldown_seconds
        self._adb_cooldown = adb_cooldown_seconds
        self._retry_waits = retry_waits
        self._settle = settle_seconds
        self._budget = budget_seconds
        self._requested = asyncio.Event()
        self._rest_until = 0.0
        self._attempts = 0
        self._only_adb_down = True
        manager.on_needs_repair(self.request)

    def request(self) -> None:
        """Avisa que uma porta do controle foi recusada. Síncrono, barato e sem falha possível."""
        self._requested.set()

    async def run(self) -> None:
        """Laço de fundo: espera um aviso e cuida dele, um de cada vez, até ser cancelado."""
        while True:
            await self._requested.wait()
            try:
                await self.handle()
            except Exception:
                _log.exception("falha inesperada no vigia da TV")
            finally:
                # Avisos que chegaram durante o reparo são do mesmo problema.
                self._requested.clear()

    async def handle(self) -> None:
        """Confere se o serviço está mesmo fora e, estando, tenta religá-lo."""
        if self._clock.monotonic() < self._rest_until or self._manager.state is SessionState.HOT:
            return
        if await self._service_up(on_error=True) is not False:
            return  # de pé, ou a TV nem está na rede (standby): nada a religar
        self._manager.mark_repairing()
        try:
            await self._repair()
        finally:
            self._manager.clear_repairing()
            await self._events.flush()

    async def _service_up(self, *, on_error: bool) -> bool | None:
        try:
            return await self._ports_open()
        except Exception as exc:
            _log.info("vigia não conseguiu conferir as portas da TV (%s)", type(exc).__name__)
            return on_error

    async def _repair(self) -> None:
        self._events.emit("repair_started", "info", "Religando o controle da TV.")
        self._attempts = 0
        self._only_adb_down = True
        try:
            async with asyncio.timeout(self._budget):
                reported = await self._try_until_up()
        except TimeoutError:
            _log.warning("o reparo do controle da TV passou do tempo máximo")
            self._only_adb_down = False
            reported = False
        if reported:
            return
        self._rest_until = self._clock.monotonic() + self._cooldown
        if self._only_adb_down:
            self._events.emit(
                "adb_unreachable",
                "warn",
                "ADB da TV não respondeu; controle não religado.",
                self._attempts,
            )
        else:
            self._events.emit(
                "repair_failed",
                "error",
                "Não foi possível religar o controle da TV.",
                self._attempts,
            )

    async def _try_until_up(self) -> bool:
        """Tenta religar até as portas atenderem. Devolve se o desfecho já foi comunicado (serviço
        de volta, ou ADB que nunca vai servir); `False` quando todas as tentativas falharam."""
        for wait in (0.0, *self._retry_waits):
            if wait:
                await self._clock.sleep(wait)
            self._attempts += 1
            try:
                await self._restart()
            except AdbUnauthorized, AdbUnavailable:
                # Sem autorização ou sem o `adb`, insistir não adianta e só cansaria a TV.
                self._rest_until = self._clock.monotonic() + self._adb_cooldown
                self._events.emit(
                    "adb_unreachable",
                    "warn",
                    "ADB da TV sem autorização ou ausente; controle não religado.",
                    self._attempts,
                )
                return True
            except AdbNotReady:
                # A TV pode estar subindo (queda de energia): o ADB demora mais que o serviço.
                continue
            except Exception as exc:
                self._only_adb_down = False
                _log.info("tentativa de religar o controle da TV falhou (%s)", type(exc).__name__)
                continue
            await self._clock.sleep(self._settle)
            if await self._service_up(on_error=False) is True:
                _log.info("controle da TV religado na tentativa %d", self._attempts)
                self._events.emit(
                    "repaired", "info", "Controle remoto da TV religado.", self._attempts
                )
                return True
            self._only_adb_down = False
        return False
