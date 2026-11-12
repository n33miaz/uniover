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

from uniover_agent.adapters.ssl_contexts import ssl_contexts
from uniover_agent.ports import (
    ConnectionReplaced,
    CredentialRejected,
    HandoverRequested,
    HandoverUnsupported,
    ServerRestarting,
    ServerRestartNow,
    TransportError,
)

_log = logging.getLogger(__name__)

# Igual ao limite do servidor: mensagem maior fecha a conexão com 1009.
MAX_MESSAGE_BYTES: Final = 64 * 1024
PING_INTERVAL_SECONDS: Final = 20.0
# Com o trabalho síncrono fora do laço, o prazo padrão volta a detectar um canal morto rapidamente.
PING_TIMEOUT_SECONDS: Final = 20.0
# A API dormindo (Render grátis) acorda em até ~1 minuto: a abertura espera 105 s e, se não deu, o
# laço tenta de novo (com espera crescente) em vez de deixar o agente fora do ar por minutos. O
# prazo do laço de conexão (`CONNECT_TIMEOUT_SECONDS`, 120 s) é a segunda barreira, acima deste.
OPEN_TIMEOUT_SECONDS: Final = 105.0

_REPLACED_REASON: Final = "replaced"
_HANDOVER_REASON: Final = "handover"
# A versão nova da passagem sem queda conecta numa rota PRÓPRIA (`<canal>/handover`) e é, ali,
# CANDIDATA a assumir a conexão: até o `hello` dela dizer `handover`, a API a deixa fora do
# roteamento e não fecha a velha. Rota, e não cabeçalho, porque uma API que não conhece a passagem
# (a instância anterior, numa troca em andamento) ignora um cabeçalho e trataria a candidata como
# conexão comum, substituindo a que serve; uma rota que ela não tem responde 404 e ninguém sai.
HANDOVER_PATH: Final = "/handover"
_REVOKED_REASON: Final = "revoked"
# Códigos que a API usa depois do upgrade: 4403 revogação, 4409 substituição, 4411 reinício.
_REPLACED_CLOSE_CODE: Final = 4409
_HANDOVER_CLOSE_CODE: Final = 4410
# Códigos de aplicação que a API usa para recusa de credencial depois do upgrade.
_CREDENTIAL_CLOSE_CODES: Final = frozenset({4401, 4403})
_CREDENTIAL_STATUS: Final = frozenset({401, 403})
_NOT_FOUND_STATUS: Final = 404
# 4411 "server-restart": a API que vai parar manda reconectar já (a API só o envia a quem declarou
# `transport.restart.v1`). Tem a volta mais curta de todas.
_SERVER_RESTART_REASON: Final = "server-restart"
_SERVER_RESTART_CLOSE_CODE: Final = 4411
# 1001 (indo embora) e 1012 (reinício do serviço): o servidor está trocando de instância.
_RESTART_CLOSE_CODES: Final = frozenset({1001, 1012})
# 1008: a API fechou por violação de política (recusou mensagens demais desta conexão).
POLICY_VIOLATION_CODE: Final = 1008


def build_ws_url(api_url: str, agent_id: str) -> str:
    """Troca o esquema (https->wss, http->ws) e aponta para o canal do agente."""
    parts = urlsplit(api_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = f"{parts.path.rstrip('/')}/api/v1/devices/agents/{agent_id}/ws"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def candidate_url(url: str) -> str:
    """O endereço da rota da candidata da passagem, a partir do canal comum."""
    parts = urlsplit(url)
    path = f"{parts.path.rstrip('/')}{HANDOVER_PATH}"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


def _close_outcome(close: Close | None) -> Exception | None:  # noqa: PLR0911 - um retorno por código
    """Traduz o fechamento recebido do servidor: revogação e `replaced` têm tratamento próprio."""
    if close is None:
        return None
    reason = close.reason.strip().lower()
    if reason == _HANDOVER_REASON or close.code == _HANDOVER_CLOSE_CODE:
        return HandoverRequested("uma versão nova assumiu a conexão")
    if reason == _REPLACED_REASON or close.code == _REPLACED_CLOSE_CODE:
        return ConnectionReplaced("outra conexão do mesmo agente assumiu")
    if reason == _REVOKED_REASON or close.code in _CREDENTIAL_CLOSE_CODES:
        return CredentialRejected("o servidor encerrou por revogação da credencial")
    if close.code == _SERVER_RESTART_CLOSE_CODE or reason == _SERVER_RESTART_REASON:
        return ServerRestartNow("a API vai parar e pediu para reconectar já")
    if close.code in _RESTART_CLOSE_CODES:
        detail = f"código {close.code}"
        if close.reason:
            detail += f", motivo {close.reason!r}"
        return ServerRestarting(detail)
    return None


class WebSocketTransport:
    """Implementa a porta `Transport` por WebSocket.

    O token vem de `token_provider` a cada conexão (lido do cofre) e só vai no cabeçalho
    `Authorization` do upgrade: nunca em URL, log ou mensagem de erro.
    """

    def __init__(  # noqa: PLR0913 - opções do canal, todas com padrão
        self,
        url: str,
        token_provider: Callable[[], str | None],
        *,
        user_agent: str = "uniover-agent",
        open_timeout: float = OPEN_TIMEOUT_SECONDS,
        ping_interval: float = PING_INTERVAL_SECONDS,
        ping_timeout: float = PING_TIMEOUT_SECONDS,
        handover_candidate: Callable[[], bool] | None = None,
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
        self._ping_timeout = ping_timeout
        # Verdadeiro até a API confirmar a promoção: toda conexão da versão nova até lá é candidata
        # (rota própria), e nenhuma delas substitui a antiga por engano.
        self._handover_candidate = handover_candidate
        self._ws: ClientConnection | None = None
        # O código com que o servidor fechou a última conexão (`None`: ainda aberta, ou caiu sem
        # quadro de fechamento). Quem monta o agente o lê ao saber da queda.
        self.last_close_code: int | None = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def connect(self) -> None:
        token = self._token_provider()
        if not token:
            raise CredentialRejected("não há token de dispositivo no cofre")
        headers = {"Authorization": f"Bearer {token}"}
        candidate = self._handover_candidate is not None and self._handover_candidate()
        url = candidate_url(self._url) if candidate else self._url
        self.last_close_code = None
        # O contexto TLS sai pronto de uma thread: criá-lo no laço a cada reconexão o travava.
        tls = await ssl_contexts.verified() if self._url.startswith("wss:") else None
        try:
            self._ws = await connect(
                url,
                ssl=tls,
                additional_headers=headers,
                user_agent_header=self._user_agent,
                ping_interval=self._ping_interval,
                ping_timeout=self._ping_timeout,
                max_size=MAX_MESSAGE_BYTES,
                open_timeout=self._open_timeout,
            )
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status in _CREDENTIAL_STATUS:
                raise CredentialRejected(
                    f"o servidor recusou a credencial (HTTP {status})"
                ) from None
            if candidate and status == _NOT_FOUND_STATUS:
                raise HandoverUnsupported("a API não tem a rota da passagem") from None
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
            self.last_close_code = exc.rcvd.code if exc.rcvd is not None else None
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
            self.last_close_code = exc.rcvd.code if exc.rcvd is not None else None
            outcome = _close_outcome(exc.rcvd)
            if outcome is not None:
                raise outcome from None
            if exc.rcvd is None:
                # Nenhum quadro de fechamento veio: ou a conexão sumiu (proxy, rede) ou fomos nós,
                # por falta de pong (1011 enviado). Não é "o servidor fechou".
                sent = f", enviado {exc.sent.code}" if exc.sent else ""
                raise TransportError(f"conexão perdida sem aviso do servidor{sent}") from None
            reason = f", motivo {exc.rcvd.reason!r}" if exc.rcvd.reason else ""
            raise TransportError(
                f"fechada pelo servidor (código {exc.rcvd.code}{reason})"
            ) from None
        # Fechamento limpo: ainda assim o motivo pode ser `replaced` ou revogação.
        received = ws.protocol.close_rcvd
        self.last_close_code = received.code if received is not None else None
        outcome = _close_outcome(received)
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
