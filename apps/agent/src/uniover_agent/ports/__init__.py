"""Portas (Protocol) que o núcleo usa; adaptadores as implementam."""

from datetime import datetime
from typing import Any, Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...


class SecretStore(Protocol):
    def get(self, name: str) -> str | None: ...

    def set(self, name: str, value: str) -> None: ...


class Transport(Protocol):
    """Canal de mensagens com a API; WebSocket hoje, MQTT depois, mesmo envelope."""

    async def receive(self) -> dict[str, Any]: ...

    async def send(self, message: dict[str, Any]) -> None: ...


class TvRemote(Protocol):
    async def send_key(self, key: str) -> None: ...


__all__ = ["Clock", "SecretStore", "Transport", "TvRemote"]
