"""Apoio dos testes: envelopes válidos e um servidor WebSocket falso local (sem rede externa)."""

import json
import uuid
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from types import TracebackType
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

AGENT_ID = "pc-casa"
TOKEN = "uo_dev_TOKEN-SECRETO-DE-TESTE"


def envelope(
    message_type: str,
    body: dict[str, Any],
    *,
    correlation_id: str | None = None,
    source: str = "api",
    target: str = f"agent:{AGENT_ID}",
    **overrides: Any,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "v": 1,
        "id": str(uuid.uuid4()),
        "type": message_type,
        "source": source,
        "target": target,
        "ts": "2026-10-19T12:00:00.000Z",
        "correlationId": correlation_id,
        "body": body,
    }
    data.update(overrides)
    return data


def tv_key(key: str = "VOLUME_UP", correlation_id: str | None = None, **kw: Any) -> dict[str, Any]:
    return envelope("tv.key.v1", {"key": key}, correlation_id=correlation_id, **kw)


def dump(data: dict[str, Any]) -> str:
    return json.dumps(data)


Script = Callable[[ServerConnection], Awaitable[None]]


class FakeApi:
    """Servidor WebSocket falso: guarda cabeçalhos e mensagens e roda o roteiro de cada conexão."""

    def __init__(self, script: Script | None = None, *, reject_status: int | None = None) -> None:
        self.script = script
        self.reject_status = reject_status
        self.authorizations: list[str | None] = []
        self.paths: list[str] = []
        self.received: list[dict[str, Any]] = []
        self.connections = 0
        self._server: Server | None = None
        self.port = 0

    async def _process(self, connection: ServerConnection, request: Request) -> Response | None:
        self.authorizations.append(request.headers.get("Authorization"))
        self.paths.append(request.path)
        if self.reject_status is not None:
            status = HTTPStatus(self.reject_status)
            return Response(status.value, status.phrase, Headers(), b"")
        return None

    async def _handle(self, connection: ServerConnection) -> None:
        self.connections += 1
        if self.script is not None:
            await self.script(connection)
        try:
            async for raw in connection:
                self.received.append(json.loads(raw))
        except Exception:  # noqa: S110 - o cliente fechou; o teste só observa
            pass

    async def __aenter__(self) -> FakeApi:
        self._server = await serve(
            self._handle, "127.0.0.1", 0, process_request=self._process, max_size=2**20
        )
        self.port = next(iter(self._server.sockets)).getsockname()[1]
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/api/v1/devices/agents/{AGENT_ID}/ws"

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"
