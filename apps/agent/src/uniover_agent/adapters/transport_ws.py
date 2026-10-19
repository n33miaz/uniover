"""Transporte WebSocket (biblioteca `websockets`): o agente disca para a API, nunca abre porta."""

import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any, Final
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import (
    ConnectionClosed,
    InvalidHandshake,
    InvalidStatus,
    WebSocketException,
)
from websockets.frames import Close

from uniover_agent.ports import ConnectionReplaced, CredentialRejected, TransportError

_log = logging.getLogger(__name__)

# Igual ao limite do servidor: mensagem maior fecha a conexão com 1009.
MAX_MESSAGE_BYTES: Final = 64 * 1024
PING_INTERVAL_SECONDS: Final = 20.0
# Acordar a API dormindo (Render) pode passar de 4 minutos: a abertura espera até 5.
OPEN_TIMEOUT_SECONDS: Final = 300.0

_REPLACED_REASON: Final = "replaced"
_REVOKED_REASON: Final = "revoked"
# Códigos que a API usa depois do upgrade: 4403 revogação, 4409 substituição.
_REPLACED_CLOSE_CODE: Final = 4409
# Códigos de aplicação que a API usa para recusa de credencial depois do upgrade.
_CREDENTIAL_CLOSE_CODES: Final = frozenset({4401, 4403})
_CREDENTIAL_STATUS: Final = frozenset({401, 403})


def build_ws_url(api_url: str, agent_id: str) -> str:
    """Troca o esquema (https->wss, http->ws) e aponta para o canal do agente."""
    parts = urlsplit(api_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = f"{parts.path.rstrip('/')}/api/v1/devices/agents/{agent_id}/ws"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def _close_outcome(close: Close | None) -> Exception | None:
    """Traduz o fechamento recebido do servidor: revogação e `replaced` têm tratamento próprio."""
    if close is None:
        return None
    reason = close.reason.strip().lower()
    if reason == _REPLACED_REASON or close.code == _REPLACED_CLOSE_CODE:
        return ConnectionReplaced("outra conexão do mesmo agente assumiu")
    if reason == _REVOKED_REASON or close.code in _CREDENTIAL_CLOSE_CODES:
        return CredentialRejected("o servidor encerrou por revogação da credencial")
    return None


class WebSocketTransport:
    """Implementa a porta `Transport` por WebSocket.

    O token vem de `token_provider` a cada conexão (lido do cofre) e só vai no cabeçalho
    `Authorization` do upgrade: nunca em URL, log ou mensagem de erro.
    """

    def __init__(
        self,
        url: str,
        token_provider: Callable[[], str | None],
        *,
        user_agent: str = "uniover-agent",
        open_timeout: float = OPEN_TIMEOUT_SECONDS,
        ping_interval: float = PING_INTERVAL_SECONDS,
    ) -> None:
        if url.startswith("ws://"):
            _log.warning("canal sem criptografia (ws://); só para desenvolvimento")
        elif not url.startswith("wss://"):
            raise ValueError(
                "a URL do canal precisa começar com wss:// (ou ws:// em desenvolvimento)"
            )
        self._url = url
        self._token_provider = token_provider
        self._user_agent = user_agent
        self._open_timeout = open_timeout
        self._ping_interval = ping_interval
        self._ws: ClientConnection | None = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def connect(self) -> None:
        token = self._token_provider()
        if not token:
            raise CredentialRejected("não há token de dispositivo no cofre")
        try:
            self._ws = await connect(
                self._url,
                additional_headers={"Authorization": f"Bearer {token}"},
                user_agent_header=self._user_agent,
                ping_interval=self._ping_interval,
                max_size=MAX_MESSAGE_BYTES,
                open_timeout=self._open_timeout,
            )
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status in _CREDENTIAL_STATUS:
                raise CredentialRejected(
                    f"o servidor recusou a credencial (HTTP {status})"
                ) from None
            raise TransportError(f"o servidor recusou a abertura (HTTP {status})") from None
        except (OSError, TimeoutError, InvalidHandshake, WebSocketException) as exc:
            # Só o nome da classe: a mensagem da biblioteca não deve carregar cabeçalhos.
            raise TransportError(f"falha ao abrir o canal ({type(exc).__name__})") from None

    async def send(self, message: dict[str, Any]) -> None:
        ws = self._require()
        try:
            await ws.send(json.dumps(message, ensure_ascii=False, separators=(",", ":")))
        except ConnectionClosed as exc:
            # O servidor pode ter fechado com `replaced`/revogação antes de o envio sair.
            outcome = _close_outcome(exc.rcvd)
            if outcome is not None:
                raise outcome from None
            raise TransportError("o canal fechou durante o envio") from None

    async def incoming(self) -> AsyncIterator[str | bytes]:
        ws = self._require()
        try:
            async for message in ws:
                yield message
        except ConnectionClosed as exc:
            outcome = _close_outcome(exc.rcvd)
            if outcome is not None:
                raise outcome from None
            code = exc.rcvd.code if exc.rcvd else exc.sent.code if exc.sent else None
            raise TransportError(f"fechada pelo servidor (código {code})") from None
        # Fechamento limpo: ainda assim o motivo pode ser `replaced` ou revogação.
        outcome = _close_outcome(ws.protocol.close_rcvd)
        if outcome is not None:
            raise outcome

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()

    def _require(self) -> ClientConnection:
        if self._ws is None:
            raise TransportError("o canal não está aberto")
        return self._ws
