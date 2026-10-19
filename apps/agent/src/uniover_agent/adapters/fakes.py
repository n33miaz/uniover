"""Dublês das portas para testes e para a composição sem aparelhos reais."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from uniover_agent.ports import PairingInfo, PairingTicket, PollResult


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
    def __init__(self) -> None:
        self.keys: list[str] = []

    async def send_key(self, key: str) -> None:
        self.keys.append(key)


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
