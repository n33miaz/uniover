"""Dublês das portas para testes e para a composição sem aparelhos reais."""

import asyncio
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

from uniover_agent.ports import PairingInfo, PairingTicket, PollResult, TvUnreachable


class FakeClock:
    """Relógio virtual: `sleep` não espera, só avança o tempo e registra a duração pedida."""

    def __init__(self, fixed: datetime | None = None) -> None:
        self._fixed = fixed
        self._elapsed = 0.0
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        return self._fixed or datetime.now(UTC)

    def monotonic(self) -> float:
        return self._elapsed

    def advance(self, seconds: float) -> None:
        self._elapsed += seconds

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self._elapsed += seconds
        # Cede a vez ao laço de eventos: sem isto um laço de reconexão nunca devolveria o controle.
        await asyncio.sleep(0)


class FakeTvRemote:
    """Controle remoto roteirizado: registra o que recebe e deixa o teste empurrar estado da TV.

    `connect_errors` é consumido em ordem (um item por `connect`); sem itens, conecta.
    """

    def __init__(self) -> None:
        self.keys: list[str] = []
        self.sent: list[tuple[str, str]] = []
        self.links: list[str] = []
        self.texts: list[str] = []
        self.connects = 0
        self.disconnects = 0
        self.connect_errors: list[Exception] = []
        self.on_connect: Callable[[], None] | None = None
        self._connected = False
        self._power: list[Callable[[bool], None]] = []
        self._app: list[Callable[[str], None]] = []
        self._volume: list[Callable[[int], None]] = []
        self._available: list[Callable[[bool], None]] = []

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        # Cede a vez: dois comandos juntos precisam poder disputar o mesmo aquecimento.
        await asyncio.sleep(0)
        if self.connect_errors:
            self._connected = False
            raise self.connect_errors.pop(0)
        self._connected = True
        if self.on_connect is not None:
            self.on_connect()

    async def disconnect(self) -> None:
        self.disconnects += 1
        self._connected = False

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.keys.append(key)
        self.sent.append((key, direction))

    async def launch_link(self, link: str) -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.links.append(link)

    async def send_text(self, text: str) -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.texts.append(text)

    def on_power(self, callback: Callable[[bool], None]) -> None:
        self._power.append(callback)

    def on_app(self, callback: Callable[[str], None]) -> None:
        self._app.append(callback)

    def on_volume(self, callback: Callable[[int], None]) -> None:
        self._volume.append(callback)

    def on_available(self, callback: Callable[[bool], None]) -> None:
        self._available.append(callback)

    # --- o que a TV empurra (usado pelos testes) ---

    def push_power(self, is_on: bool) -> None:
        for callback in self._power:
            callback(is_on)

    def push_app(self, app: str) -> None:
        for callback in self._app:
            callback(app)

    def push_volume(self, level: int) -> None:
        for callback in self._volume:
            callback(level)

    def drop(self) -> None:
        """A TV derrubou a sessão sem o agente pedir."""
        self._connected = False
        for callback in self._available:
            callback(False)


class FakeTvChannel:
    """Canal genérico (o ADB, por exemplo) para testar o gerenciador com mais de um canal."""

    def __init__(self) -> None:
        self.connects = 0
        self.disconnects = 0
        self.connect_error: Exception | None = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error
        self._connected = True

    async def disconnect(self) -> None:
        self.disconnects += 1
        self._connected = False


class FakeSecretStore:
    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self._data.get(name)

    def set(self, name: str, value: str) -> None:
        self._data[name] = value

    def delete(self, name: str) -> None:
        self._data.pop(name, None)


class FakeTransport:
    """Transporte roteirizado: cada `connect` consome uma sessão; `Exception` é levantada."""

    def __init__(self, sessions: list[list[str | bytes | Exception]] | None = None) -> None:
        self.sessions = list(sessions or [])
        self.sent: list[dict[str, Any]] = []
        self.connects = 0
        self.closes = 0
        self.connect_error: Exception | None = None
        self._current: list[str | bytes | Exception] = []
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error
        self._current = self.sessions.pop(0) if self.sessions else []
        self._connected = True

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def incoming(self) -> AsyncIterator[str | bytes]:
        for item in self._current:
            if isinstance(item, Exception):
                raise item
            yield item

    async def close(self) -> None:
        self.closes += 1
        self._connected = False


class FakePairingClient:
    """Cliente de pareamento roteirizado: devolve ou levanta cada item de `polls` em ordem."""

    def __init__(self, ticket: PairingTicket, polls: list[PollResult | Exception]) -> None:
        self.ticket = ticket
        self.polls = list(polls)
        self.started: list[PairingInfo] = []
        self.poll_count = 0
        self.start_errors: list[Exception] = []

    async def start(self, info: PairingInfo) -> PairingTicket:
        self.started.append(info)
        if self.start_errors:
            raise self.start_errors.pop(0)
        return self.ticket

    async def poll(self, ticket: PairingTicket) -> PollResult:
        self.poll_count += 1
        item = self.polls.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
