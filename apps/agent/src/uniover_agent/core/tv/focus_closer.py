"""Modo Foco: com o app de stream na frente, os outros apps de usuário são fechados.

Só age quando a TV tem o Modo Foco ligado **e** a opção de fechar apps em segundo plano ligada (a
API só manda `focusClosesBackground` verdadeiro depois do clique da pessoa). Fora do foco nunca
toca em nada.

Escolha do comando: `am force-stop` por pacote, e não `am kill-all`. O `kill-all` só encerra
processos em cache e deixa de fora os que o app mantém vivos por serviço (era o caso dos apps que
"voltam sozinhos"); o `force-stop` é cirúrgico, age num pacote que a lista de proteção já aprovou
e não depende de tecla HOME (que tiraria o stream da frente). O custo é o app perder alarmes e
avisos até a próxima abertura, o que é o pedido.

Falha fecha a porta: se a tela inicial, o teclado, a acessibilidade ou os processos não puderam ser
lidos, nada é fechado.

A varredura leva vários comandos ADB e a pessoa pode trocar de app, desligar a opção ou disparar uma
limpeza no meio dela. Por isso o app em foco é protegido por **revalidação**, não por uma foto
tirada no começo: antes de cada `force-stop` confere-se que a opção segue ligada, que o foco não
terminou, que nenhuma limpeza começou e que o app da frente continua o mesmo; qualquer divergência
interrompe a varredura inteira (a próxima troca de app dispara outra).
"""

import logging
from collections.abc import Awaitable, Callable, Collection
from typing import Final

from uniover_agent.core.tv.light_settings import can_restrict_background
from uniover_agent.ports import AdbError, AdbNotReady, AdbTimeout, Clock, TvAdbCleanup

_log = logging.getLogger(__name__)

# Uma varredura por troca do app em foco; sem troca, uma conferência bem espaçada (um app pode ter
# reaberto sozinho). Nunca mais de uma por `MIN_INTERVAL_SECONDS`.
MIN_INTERVAL_SECONDS: Final = 20.0
RECHECK_SECONDS: Final = 600.0
MAX_CLOSED_PER_SWEEP: Final = 60

# O que fica aberto além da lista de nunca fechar da limpeza (`is_protected`: sistema, controle
# remoto, Play Services, configurações) e dos lançadores, teclados e instaladores já conhecidos
# (`can_restrict_background`). Serviços do Google que a TV usa para entrada, voz e vídeo.
FOCUS_PROTECTED_PREFIXES: Final = (
    "com.android.",
    "com.google.android.tv.",
    "com.google.android.apps.tv.",
    "com.google.android.inputmethod.",
    "com.google.android.katniss",
    "com.google.android.webview",
    "com.google.android.gsf",
    "com.google.android.ext.",
    "com.google.process.",
)

Report = Callable[[tuple[str, ...], int], Awaitable[None]]


def can_close_in_focus(package: str, shielded: Collection[str] = ()) -> bool:
    """Este app pode ser fechado enquanto outro está em foco? Dúvida protege."""
    return not (
        package in shielded
        or package.startswith(FOCUS_PROTECTED_PREFIXES)
        or not can_restrict_background(package)
    )


class FocusBackgroundCloser:
    def __init__(  # noqa: PLR0913, PLR0917 - dependências independentes, todas injetadas
        self,
        adb: TvAdbCleanup,
        clock: Clock,
        foreground: Callable[[], str | None],
        report: Report | None = None,
        keep: Collection[str] = (),
        is_busy: Callable[[], bool] = lambda: False,
    ) -> None:
        self._adb, self._clock, self._report = adb, clock, report
        self._foreground = foreground
        self._keep = frozenset(keep)
        self._is_busy = is_busy
        self._enabled = False
        # Muda a cada desligamento ou fim de foco: uma varredura em curso que enxerga outro número
        # foi ultrapassada pelos fatos e para antes do próximo fechamento.
        self._generation = 0
        self._sweeping = False
        self._last_foreground: str | None = None
        self._last_run: float | None = None

    def configure(self, enabled: bool) -> None:
        if enabled != self._enabled:
            self._generation += 1
        self._enabled = enabled
        if not enabled:
            self.reset()

    def reset(self) -> None:
        """O foco terminou (ou a opção desligou): a próxima entrada varre de novo."""
        self._generation += 1
        self._last_foreground = None
        self._last_run = None

    async def on_focus(self, foreground: str | None) -> None:
        """Chamado a cada leitura com o foco ativo. Nunca levanta."""
        if not self._enabled or foreground is None or self._sweeping or self._is_busy():
            return
        now = self._clock.monotonic()
        if self._last_run is not None:
            elapsed = now - self._last_run
            changed = foreground != self._last_foreground
            if elapsed < MIN_INTERVAL_SECONDS or (not changed and elapsed < RECHECK_SECONDS):
                return
        self._last_run, self._last_foreground = now, foreground
        self._sweeping = True
        try:
            if not await self._sweep(foreground, now, self._generation):
                # Interrompida: a próxima leitura com foco tenta de novo, sem a conferência lenta.
                self._last_run = self._last_foreground = None
        except AdbError as exc:
            _log.info("Modo Foco: apps de fundo não fechados agora (%s)", exc.code)
        except Exception:
            _log.exception("falha inesperada ao fechar apps de fundo no Modo Foco")
        finally:
            self._sweeping = False

    def _still_valid(self, foreground: str, generation: int) -> bool:
        """Os fatos de quando a varredura começou seguem valendo? Dúvida (foco ilegível) é não."""
        return (
            self._enabled
            and generation == self._generation
            and not self._is_busy()
            and self._foreground() == foreground
        )

    async def _sweep(self, foreground: str, started: float, generation: int) -> bool:
        """Devolve se a varredura foi até o fim (falso: o cenário mudou no meio)."""
        apps = await self._adb.list_apps()
        running = await self._adb.running_packages()
        shielded = {
            *self._keep,
            *await self._adb.home_packages(),
            *await self._adb.accessibility_packages(),
            foreground,
        }
        keyboard = await self._adb.input_method_package()
        if keyboard is not None:
            shielded.add(keyboard)
        candidates = sorted(
            {
                app.package
                for app in apps
                if app.package in running and can_close_in_focus(app.package, shielded)
            }
        )[:MAX_CLOSED_PER_SWEEP]
        closed: list[str] = []
        completed = True
        for package in candidates:
            if not self._still_valid(foreground, generation):
                _log.info("Modo Foco: varredura interrompida, o cenário mudou")
                completed = False
                break
            try:
                await self._adb.force_stop(package)
            except (AdbError, ValueError) as exc:
                # Um app que recusou não impede os outros; o ADB que sumiu para a varredura.
                if isinstance(exc, AdbNotReady | AdbTimeout):
                    break
                continue
            closed.append(package)
        _log.info(
            "Modo Foco: %d apps de fundo fechados (%s)", len(closed), ", ".join(closed) or "nenhum"
        )
        if closed and self._report is not None:
            await self._report(tuple(closed), round((self._clock.monotonic() - started) * 1000))
        return completed
