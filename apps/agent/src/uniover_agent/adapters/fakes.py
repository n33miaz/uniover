from datetime import UTC, datetime
from typing import Any


class FakeClock:
    def __init__(self, fixed: datetime | None = None) -> None:
        self._fixed = fixed

    def now(self) -> datetime:
        return self._fixed or datetime.now(UTC)


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


class FakeTransport:
    def __init__(self, incoming: list[dict[str, Any]] | None = None) -> None:
        self.incoming = list(incoming or [])
        self.sent: list[dict[str, Any]] = []

    async def receive(self) -> dict[str, Any]:
        return self.incoming.pop(0)

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
