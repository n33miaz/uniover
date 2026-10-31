"""Agendamento local das limpezas automáticas da Android TV.

O temporizador mora no agente porque a TV some da rede em standby. Ele nunca abre a sessão por
conta própria: reage somente a uma sessão que já respondeu ou a uma configuração recebida.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.cleanup import CleanupReport, TvCleanup
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError, Clock, Transport, TransportError, TvAdbCleanup

_log = logging.getLogger(__name__)

SLOW_SESSION_SECONDS: Final = 10.0
REPEAT_SECONDS: Final = 30 * 60.0
COMMAND_QUIET_SECONDS: Final = 15 * 60.0

# Comandos que querem dizer "tem gente usando a TV". O resto (batimento da API, configuração,
# pedidos de log ou de atualização) chega o tempo todo e não conta: contar tudo manteria a janela
# de silêncio da limpeza profunda aberta para sempre.
USER_ACTIVITY_TYPES: Final = frozenset(
    {"tv.text.v1", "tv.app.launch.v1", "tv.wake.v1", "tv.power.off.v1", "tv.apps.refresh.v1"}
)


def is_user_activity(command_type: str) -> bool:
    """Este comando indica uso da TV por alguém? Teclas, texto, abrir app, ligar e desligar."""
    return command_type.startswith("tv.key.") or command_type in USER_ACTIVITY_TYPES


@dataclass(frozen=True, slots=True)
class CleanupConfiguration:
    # Até a API confirmar as preferências desta TV, não se faz manutenção automática.
    light_enabled: bool = False
    deep_enabled: bool = False
    deep_threshold_mb: int = 160
    close_background_apps: bool = False


class TvCleanupScheduler:
    """Decide e executa uma limpeza automática por vez, sem disputar comandos do usuário."""

    def __init__(  # noqa: PLR0913, PLR0917 - as portas do agente, todas obrigatórias e sempre juntas
        self,
        cleanup: TvCleanup,
        adb: TvAdbCleanup,
        clock: Clock,
        transport: Transport,
        envelopes: EnvelopeFactory,
        foreground: Callable[[], str | None],
        is_focused: Callable[[], bool] = lambda: False,
    ) -> None:
        self._cleanup = cleanup
        self._adb = adb
        self._clock = clock
        self._transport = transport
        self._envelopes = envelopes
        self._foreground = foreground
        self._is_focused = is_focused
        self._configuration = CleanupConfiguration()
        self._last_light: float | None = None
        self._last_deep: float | None = None
        self._light_day: date | None = None
        self._last_command = clock.monotonic()
        self._slow_session = False
        self._last_session_ms: int | None = None
        self._pending_light = False
        self._pending_deep = False
        self._wake = asyncio.Event()
        self._wake_task: asyncio.Task[None] | None = None
        self._last_deep_skip: str | None = None
        self._closed = False

    def configure(
        self,
        light_enabled: bool,
        deep_enabled: bool,
        deep_threshold_mb: int,
        close_background_apps: bool = False,
    ) -> None:
        self._configuration = CleanupConfiguration(
            light_enabled, deep_enabled, deep_threshold_mb, close_background_apps
        )
        self._cleanup.configure_app_closing(close_background_apps)
        if not light_enabled:
            self._pending_light = False
        if not deep_enabled:
            self._pending_deep = False
        self._wake.set()

    def note_command(self) -> None:
        self._last_command = self._clock.monotonic()
        self._wake.set()

    def note_message(self, command_type: str) -> None:
        """Chamado a cada comando recebido: só o que indica uso da TV conta para o silêncio."""
        if is_user_activity(command_type):
            self.note_command()

    def note_session_opened(self, elapsed: float) -> None:
        """A sessão só chega aqui depois de a TV responder; é o ponto seguro do gatilho diário."""
        today = self._clock.now().date()
        self._last_session_ms = round(elapsed * 1000)
        if self._configuration.light_enabled and self._light_day != today:
            self._light_day = today
            self._pending_light = True
        if elapsed > SLOW_SESSION_SECONDS:
            self._slow_session = True
            if self._configuration.light_enabled:
                self._pending_light = True
            if self._configuration.deep_enabled:
                self._pending_deep = True
        self._wake.set()

    async def run(self) -> None:
        """Temporizador próprio, cancelável pelo chamador no encerramento do agente."""
        try:
            while not self._closed:
                await self._wake.wait()
                self._wake.clear()
                # Deixa a abertura da sessão e o comando que a causou terminarem.
                await asyncio.sleep(0)
                try:
                    await self.run_pending()
                except Exception:
                    # Manutenção automática nunca derruba o agente: o próximo gatilho tenta de novo.
                    _log.exception("falha na limpeza automática da TV")
        finally:
            if self._wake_task is not None:
                self._wake_task.cancel()

    async def aclose(self) -> None:
        self._closed = True
        self._wake.set()

    def resume(self) -> None:
        """O foco terminou: o que ficou pendente durante a trégua volta a ser avaliado."""
        self._wake.set()

    async def run_pending(self) -> None:
        if self._is_focused():
            # Enquanto há mídia confirmada, a limpeza (até a leve) espera; o gatilho fica pendente.
            return
        if (
            self._pending_light
            and self._configuration.light_enabled
            and self._may_repeat(self._last_light)
        ):
            self._pending_light = False
            await self._run_light()
        if (
            self._pending_deep
            and self._configuration.deep_enabled
            and self._may_repeat(self._last_deep)
        ):
            await self._run_deep()

    def _may_repeat(self, previous: float | None) -> bool:
        return previous is None or self._clock.monotonic() - previous >= REPEAT_SECONDS

    async def _run_light(self) -> None:
        started = self._clock.monotonic()
        try:
            report = await self._cleanup.run_light(self._foreground())
        except TvSessionError as exc:
            await self._send_skipped("light", "automatic", exc.code)
            return
        self._last_light = self._clock.monotonic()
        await self._send_completed("light", "automatic", started, report)

    async def _run_deep(self) -> None:
        if not self._configuration.close_background_apps:
            # A limpeza profunda existe para fechar apps; sem a opção da TV ela não tem o que fazer.
            self._pending_deep = False
            await self._send_skipped("deep", "automatic", "app-closing-disabled")
            return
        needed = await self._deep_needed()
        if needed is None:
            await self._send_skipped("deep", "automatic", "memory-unavailable")
            return
        if not needed:
            self._pending_deep = False
            return
        blocker = await self._deep_blocker()
        if blocker is not None:
            await self._send_skipped("deep", "automatic", blocker)
            return
        quiet_for = self._clock.monotonic() - self._last_command
        if quiet_for < COMMAND_QUIET_SECONDS:
            # A profunda continua pendente: passada a janela quieta o temporizador acorda e reavalia
            # todas as leituras, pois alguém pode ter voltado a assistir nesse intervalo. Nada dorme
            # aqui dentro, para a limpeza leve e os outros gatilhos não esperarem por ela.
            await self._send_skipped("deep", "automatic", "recent-command", throttle=False)
            self._wake_after(COMMAND_QUIET_SECONDS - quiet_for)
            return
        started = self._clock.monotonic()
        try:
            report = await self._cleanup.run()
        except TvSessionError as exc:
            await self._send_skipped("deep", "automatic", exc.code)
            return
        self._last_deep = self._clock.monotonic()
        self._last_deep_skip = None
        self._slow_session = False
        self._pending_deep = False
        await self._send_completed("deep", "automatic", started, report)

    async def _deep_needed(self) -> bool | None:
        """A limpeza profunda é necessária? Uma sessão lenta já basta; senão a memória livre decide.

        `None` quando a memória não pôde ser lida: sem medir não se toca em app nenhum.
        """
        try:
            available = await self._adb.memory_available_mb()
        except AdbError:
            return None
        if self._slow_session:
            return True
        return available is not None and available < self._configuration.deep_threshold_mb

    async def _deep_blocker(self) -> str | None:
        """O motivo de a TV poder estar em uso (ou de não dar para saber); `None` se está ociosa."""
        foreground = self._foreground()
        try:
            homes = await self._adb.home_packages()
            media_playing = await self._adb.media_playing()
        except AdbError:
            return "state-unavailable"
        if media_playing is not False:
            return "media-in-use"
        if foreground is not None and foreground not in homes:
            return "app-in-use"
        return None

    async def _send_completed(
        self, kind: str, trigger: str, started: float, report: CleanupReport
    ) -> None:
        request_id = str(uuid.uuid4())
        await self._send(
            self._envelopes.tv_cleanup_result(
                request_id,
                request_id,
                closed_apps=report.closed_apps,
                closed_packages=report.closed_packages,
                memory_before_mb=report.memory_before_mb,
                memory_after_mb=report.memory_after_mb,
                freed_mb=report.freed_mb,
                failed_steps=report.failed_steps,
                kind=kind,
                trigger=trigger,
                result="completed",
                duration_ms=round((self._clock.monotonic() - started) * 1000),
                background_processes=await self._background_processes(),
                session_open_ms=self._last_session_ms,
            )
        )

    def _wake_after(self, delay: float) -> None:
        """Acorda o temporizador daqui a `delay` segundos (um só alarme por vez)."""
        if self._wake_task is not None and not self._wake_task.done():
            return

        async def alarm() -> None:
            await self._clock.sleep(delay)
            self._wake.set()

        self._wake_task = asyncio.ensure_future(alarm())

    async def _send_skipped(
        self, kind: str, trigger: str, reason: str, *, throttle: bool = True
    ) -> None:
        if kind == "deep":
            if reason == self._last_deep_skip:
                # O mesmo motivo de novo não vira outra linha no relatório: só a mudança conta.
                return
            self._last_deep_skip = reason
            if throttle:
                self._last_deep = self._clock.monotonic()
        request_id = str(uuid.uuid4())
        await self._send(
            self._envelopes.tv_cleanup_result(
                request_id,
                request_id,
                closed_apps=0,
                closed_packages=(),
                memory_before_mb=None,
                memory_after_mb=None,
                freed_mb=None,
                failed_steps=(),
                kind=kind,
                trigger=trigger,
                result="skipped",
                reason=reason,
                duration_ms=0,
                background_processes=await self._background_processes(),
                session_open_ms=self._last_session_ms,
            )
        )

    async def _send(self, message: dict[str, object]) -> None:
        try:
            await self._transport.send(message)
        except TransportError:
            _log.info("não consegui enviar o relatório automático da limpeza")

    async def _background_processes(self) -> int | None:
        try:
            return len(await self._adb.running_packages())
        except AdbError:
            return None
