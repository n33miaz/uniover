"""Sessão da TV: conexão quente, hibernação por inatividade e reconexão no primeiro comando.

Este gerenciador é o **único** ponto que abre e fecha os canais da TV (um dono da conexão por TV:
dois clientes disputando o mesmo canal derrubam um ao outro). Não tem rede nem biblioteca de TV:
recebe os canais pelas portas e o relógio por injeção, então os testes andam o tempo à mão.

Dois estados diferentes, de propósito:

* `SessionState` é a máquina interna (dormindo, aquecendo, quente, reparando);
* `TvState` é o que se publica (`tv.state.v1`). Dormir **nunca** vira "TV desligada": o agente que
  hiberna não é a TV em standby, então `power` fica `unknown` sempre que o canal não está aberto.
"""

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, NoReturn

from uniover_agent.core.domain import Connection, Power, TvState
from uniover_agent.ports import (
    Clock,
    TvChannel,
    TvChannelError,
    TvNotPaired,
    TvPortClosed,
    TvRemote,
    TvUnreachable,
)

_log = logging.getLogger(__name__)

TV_UNREACHABLE: Final = "tv_unreachable"
TV_NOT_PAIRED: Final = "tv_not_paired"

DEFAULT_HIBERNATE_SECONDS: Final = 300.0
# Espera entre as tentativas de abrir a sessão (1, 2 e 4 s) e depois desiste: sem laço infinito.
DEFAULT_BACKOFF: Final = (1.0, 2.0, 4.0)
# De quanto em quanto tempo o vigia de inatividade confere; a hibernação atrasa no máximo isso.
DEFAULT_POLL_SECONDS: Final = 5.0
_WARMUP_HISTORY: Final = 100


class SessionState(StrEnum):
    HIBERNATING = "hibernating"
    WARMING = "warming"
    HOT = "hot"
    # Reservado ao vigia: ele entra e sai por `mark_repairing` e `clear_repairing`.
    REPAIRING = "repairing"


class TvSessionError(Exception):
    """A TV não pôde executar o comando; `code` vai para a API e `message` para o dono."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(slots=True)
class _Registered:
    channel: TvChannel
    required: bool


class TvSessionManager:
    def __init__(
        self,
        clock: Clock,
        remote: TvRemote,
        *,
        hibernate_seconds: float = DEFAULT_HIBERNATE_SECONDS,
        backoff: tuple[float, ...] = DEFAULT_BACKOFF,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
    ) -> None:
        self._clock = clock
        self._remote = remote
        self._hibernate_seconds = hibernate_seconds
        self._backoff = backoff
        self._poll_seconds = poll_seconds
        self._channels: list[_Registered] = [_Registered(remote, required=True)]
        self._state = SessionState.HIBERNATING
        self._connection: Connection = "hibernating"
        self._power: bool | None = None
        self._volume: int | None = None
        self._app: str | None = None
        self._last_activity = clock.monotonic()
        # Serializa abrir e fechar: dois comandos chegando juntos esperam o mesmo aquecimento.
        self._lock = asyncio.Lock()
        self._listeners: list[Callable[[TvState], None]] = []
        self._repair_callbacks: list[Callable[[], None]] = []
        self._last_emitted: TvState | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self.warmups: deque[float] = deque(maxlen=_WARMUP_HISTORY)
        remote.on_power(self._on_power)
        remote.on_app(self._on_app)
        remote.on_volume(self._on_volume)
        remote.on_available(self._on_available)

    # --- interface pública -------------------------------------------------------------------

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def last_warmup_seconds(self) -> float | None:
        """Duração do último aquecimento (para a medição de religação)."""
        return self.warmups[-1] if self.warmups else None

    def snapshot(self) -> TvState:
        """O que se publica agora. `power` só é afirmado com a sessão quente."""
        power: Power = "unknown"
        if self._connection == "hot" and self._power is not None:
            power = "on" if self._power else "off"
        return TvState(power, self._volume, self._app, self._connection)

    def subscribe(self, listener: Callable[[TvState], None]) -> None:
        """Avisa a cada mudança de estado publicável (chamada síncrona, no laço de eventos)."""
        self._listeners.append(listener)

    def on_needs_repair(self, callback: Callable[[], None]) -> None:
        """Sinal para o vigia: a TV recusou a conexão (o serviço do controle pode ter morrido).

        Dispara uma vez por aquecimento, já na primeira recusa; o vigia confere as portas. Uma TV
        que simplesmente não responde (standby, sem rede) não dispara o sinal.
        """
        self._repair_callbacks.append(callback)

    def add_channel(self, channel: TvChannel, *, required: bool = False) -> None:
        """Registra outro canal (ADB) para abrir e fechar junto com a sessão.

        Canal opcional que falha ao abrir só vai para o log: o controle por teclas segue.
        """
        self._channels.append(_Registered(channel, required))

    def touch(self) -> None:
        """Renova o relógio de hibernação."""
        self._last_activity = self._clock.monotonic()

    def mark_repairing(self) -> None:
        """O vigia assumiu: novos comandos devolvem `tv_unreachable` até `clear_repairing`."""
        if self._state is SessionState.REPAIRING:
            return
        self._state = SessionState.REPAIRING
        self._set_connection("disconnected")

    def clear_repairing(self) -> None:
        """O vigia terminou: volta a dormir; o próximo comando abre a sessão do zero."""
        if self._state is not SessionState.REPAIRING:
            return
        self._state = SessionState.HIBERNATING
        self._set_connection("hibernating")

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await self._run(lambda remote: remote.send_key(key, direction))

    async def launch_link(self, link: str) -> None:
        await self._run(lambda remote: remote.launch_link(link))

    async def send_text(self, text: str) -> None:
        """Define o texto do campo em foco na TV (substitui o conteúdo; não acrescenta)."""
        await self._run(lambda remote: remote.send_text(text))

    async def wake(self) -> None:
        """Pré-aquece: abre a sessão (se preciso) e renova o relógio."""
        self.touch()
        await self._ensure_hot()

    async def hibernate_if_idle(self) -> bool:
        """Fecha os canais se passou o tempo sem comando; devolve se hibernou."""
        if self._state is not SessionState.HOT or not self._is_idle():
            return False
        async with self._lock:
            # Reconfere dentro do lock: um comando pode ter chegado enquanto se esperava.
            if self._state is not SessionState.HOT or not self._is_idle():
                return False
            await self._close_channels()
            self._state = SessionState.HIBERNATING
            self._set_connection("hibernating")
            _log.info("TV hibernada depois de %.0f s sem uso", self._hibernate_seconds)
            return True

    async def watch(self) -> None:
        """Laço de fundo: confere a inatividade até ser cancelado."""
        while True:
            await self._clock.sleep(self._poll_seconds)
            await self.hibernate_if_idle()

    async def aclose(self) -> None:
        """Encerramento do agente: cancela o que estiver em segundo plano e fecha os canais."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with self._lock:
            await self._close_channels()
            if self._state is not SessionState.REPAIRING:
                self._state = SessionState.HIBERNATING
                self._set_connection("hibernating")

    async def settle(self) -> None:
        """Espera as recuperações em segundo plano terminarem (testes e encerramento)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
            # Cede a vez: o `discard` de quem já terminou roda como callback do laço.
            await asyncio.sleep(0)

    # --- comandos ----------------------------------------------------------------------------

    async def _run(self, action: Callable[[TvRemote], Awaitable[None]]) -> None:
        self.touch()
        await self._ensure_hot()
        try:
            await action(self._remote)
        except TvChannelError as exc:
            # O canal caiu entre a conferência e o envio: reabre uma vez e repete.
            _log.info("canal da TV caiu durante o comando (%s); reabrindo", exc)
            self._channel_lost()
            await self._ensure_hot()
            try:
                await action(self._remote)
            except TvChannelError as again:
                raise TvSessionError(TV_UNREACHABLE, str(again)) from None

    def _is_idle(self) -> bool:
        return self._clock.monotonic() - self._last_activity >= self._hibernate_seconds

    def _is_hot(self) -> bool:
        return self._state is SessionState.HOT and all(
            reg.channel.connected for reg in self._channels if reg.required
        )

    def _raise_if_repairing(self) -> None:
        if self._state is SessionState.REPAIRING:
            raise TvSessionError(TV_UNREACHABLE, "religando o controle da TV; tente em instantes")

    # --- abertura e fechamento ---------------------------------------------------------------

    async def _ensure_hot(self) -> None:
        self._raise_if_repairing()
        if self._is_hot():
            return
        async with self._lock:
            self._raise_if_repairing()
            if self._is_hot():
                return
            try:
                await self._warm()
            except BaseException:
                # Cancelamento ou erro inesperado no meio do aquecimento: não deixa `WARMING` preso.
                if self._state is SessionState.WARMING:
                    await asyncio.shield(self._close_channels())
                    self._state = SessionState.HIBERNATING
                    self._set_connection("disconnected")
                raise

    async def _warm(self) -> None:
        """Abre os canais, com espera de 1, 2 e 4 s entre as tentativas; chamada com o lock."""
        self._state = SessionState.WARMING
        started = self._clock.monotonic()
        delays: list[float | None] = [*self._backoff, None]
        signaled = False
        for attempt, delay in enumerate(delays, start=1):
            try:
                await self._open_channels()
            except TvNotPaired as exc:
                await self._give_up(TV_NOT_PAIRED, str(exc))
            except TvUnreachable as exc:
                if not signaled and isinstance(exc, TvPortClosed):
                    # Porta recusada (serviço morto) já na primeira falha: o vigia ganha a janela
                    # das esperas para agir. Sem resposta nenhuma é a TV em standby: não é reparo.
                    signaled = True
                    self._signal_needs_repair()
                if delay is None:
                    await self._give_up(TV_UNREACHABLE, str(exc))
                _log.warning("TV não respondeu (tentativa %d): %s", attempt, exc)
                await self._clock.sleep(delay)
                self._raise_if_repairing()
            else:
                break
        if self._state is SessionState.REPAIRING:
            # O vigia assumiu durante a abertura: não se mantém uma sessão que ele vai refazer.
            await self._close_channels()
            self._raise_if_repairing()
        elapsed = self._clock.monotonic() - started
        self.warmups.append(elapsed)
        _log.info("sessão da TV aberta em %.2f s", elapsed)
        self._state = SessionState.HOT
        self.touch()
        self._set_connection("hot")

    async def _open_channels(self) -> None:
        opened: list[TvChannel] = []
        for reg in self._channels:
            try:
                await reg.channel.connect()
            except TvChannelError as exc:
                if reg.required:
                    for channel in opened:
                        await self._safe_disconnect(channel)
                    raise
                _log.warning("canal opcional da TV indisponível: %s", exc)
            else:
                opened.append(reg.channel)

    async def _give_up(self, code: str, message: str) -> NoReturn:
        await self._close_channels()
        if self._state is not SessionState.REPAIRING:
            self._state = SessionState.HIBERNATING
            self._set_connection("disconnected")
        self._raise_if_repairing()
        _log.warning("sessão da TV não abriu (%s): %s", code, message)
        hint = (
            "a TV ainda não foi pareada; rode `uniover-agent tv-pair`"
            if code == TV_NOT_PAIRED
            else "a TV não respondeu ao controle remoto"
        )
        raise TvSessionError(code, hint)

    async def _close_channels(self) -> None:
        for reg in self._channels:
            await self._safe_disconnect(reg.channel)

    @staticmethod
    async def _safe_disconnect(channel: TvChannel) -> None:
        try:
            await channel.disconnect()
        except TvChannelError as exc:
            _log.warning("falha ao fechar canal da TV: %s", exc)

    def _signal_needs_repair(self) -> None:
        for callback in self._repair_callbacks:
            try:
                callback()
            except Exception:
                _log.exception("falha no aviso de reparo da TV")

    # --- queda do canal e recuperação em segundo plano ----------------------------------------

    def _channel_lost(self) -> None:
        """O canal fechou sem o agente pedir (a TV derrubou o serviço, a rede piscou)."""
        if self._state is not SessionState.HOT:
            return
        self._state = SessionState.HIBERNATING
        self._set_connection("disconnected")
        self._spawn(self._recover())

    async def _recover(self) -> None:
        if self._state is not SessionState.HIBERNATING:
            return
        if self._is_idle():
            # Ninguém usa há tempo demais: dormir sai mais barato do que reabrir para nada.
            async with self._lock:
                if self._state is SessionState.HIBERNATING:
                    await self._close_channels()
                    self._set_connection("hibernating")
            return
        try:
            await self._ensure_hot()
        except TvSessionError as exc:
            _log.warning("TV não voltou sozinha: %s", exc.message)

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> None:
        task = asyncio.get_running_loop().create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # --- estado empurrado pela TV -------------------------------------------------------------

    def _on_power(self, is_on: bool) -> None:
        self._power = is_on
        self._emit()

    def _on_app(self, app: str) -> None:
        self._app = app or None
        self._emit()

    def _on_volume(self, level: int) -> None:
        self._volume = max(0, min(100, level))
        self._emit()

    def _on_available(self, available: bool) -> None:
        if not available:
            self._channel_lost()

    def _set_connection(self, connection: Connection) -> None:
        self._connection = connection
        self._emit()

    def _emit(self) -> None:
        snapshot = self.snapshot()
        if snapshot == self._last_emitted:
            return
        self._last_emitted = snapshot
        for listener in self._listeners:
            try:
                listener(snapshot)
            except Exception:
                _log.exception("falha ao publicar o estado da TV")
