"""Pareamento por HTTP (httpx): `pairing/start` e `pairing/poll`, ambos anônimos na API."""

import logging
from http import HTTPStatus
from typing import Any

import httpx

from uniover_agent.ports import (
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingNotFound,
    PairingRateLimited,
    PairingTicket,
    PairingUnavailable,
    PollApproved,
    PollPending,
    PollResult,
    PollSlowDown,
)

_log = logging.getLogger(__name__)

_BASE = "/api/v1/devices"
# A API grátis dorme: a primeira chamada pode demorar minutos para ser atendida.
_TIMEOUT = httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)
_DEFAULT_RETRY_AFTER = 5.0


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        raise PairingError("resposta da API fora do esperado") from None
    if not isinstance(data, dict):
        raise PairingError("resposta da API fora do esperado")
    return data


def _retry_after(response: httpx.Response) -> float:
    try:
        return max(1.0, float(response.headers.get("Retry-After", _DEFAULT_RETRY_AFTER)))
    except ValueError:
        return _DEFAULT_RETRY_AFTER


def _raise_for_problem(response: httpx.Response) -> None:
    """Mapeia os erros do pareamento (404, 410, 403, 429, 5xx) para exceções da porta."""
    status = response.status_code
    if status == HTTPStatus.NOT_FOUND:
        raise PairingNotFound("pareamento não encontrado")
    if status == HTTPStatus.GONE:
        raise PairingExpired("o código venceu ou o token já foi entregue")
    if status == HTTPStatus.FORBIDDEN:
        raise PairingDenied("o pareamento foi recusado")
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        raise PairingRateLimited(_retry_after(response))
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        raise PairingUnavailable(f"API indisponível (HTTP {status})")
    raise PairingError(f"a API recusou o pedido (HTTP {status})")


def _string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise PairingError("resposta da API fora do esperado")
    return value


def _integer(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise PairingError("resposta da API fora do esperado")
    return value


class HttpPairingClient:
    """Cliente do pareamento. `deviceCode` e token nunca aparecem em log nem em mensagem de erro."""

    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client

    async def _post(self, path: str, payload: dict[str, str]) -> httpx.Response:
        try:
            if self._client is not None:
                return await self._client.post(self._base_url + path, json=payload)
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                return await client.post(self._base_url + path, json=payload)
        except httpx.HTTPError as exc:
            raise PairingUnavailable(f"sem resposta da API ({type(exc).__name__})") from None

    async def start(self, info: PairingInfo) -> PairingTicket:
        response = await self._post(
            f"{_BASE}/pairing/start",
            {
                "agentName": info.agent_name,
                "platform": info.platform,
                "agentVersion": info.agent_version,
            },
        )
        if response.status_code != HTTPStatus.OK:
            _raise_for_problem(response)
        data = _json(response)
        return PairingTicket(
            pairing_id=_string(data, "pairingId"),
            device_code=_string(data, "deviceCode"),
            user_code=_string(data, "userCode"),
            expires_in=_integer(data, "expiresIn"),
            interval=_integer(data, "interval"),
        )

    async def poll(self, ticket: PairingTicket) -> PollResult:
        response = await self._post(
            f"{_BASE}/pairing/poll",
            {"pairingId": ticket.pairing_id, "deviceCode": ticket.device_code},
        )
        if response.status_code != HTTPStatus.OK:
            _raise_for_problem(response)
        data = _json(response)
        status = data.get("status")
        if status == "pending":
            return PollPending()
        if status == "slow_down":
            return PollSlowDown(_integer(data, "interval"))
        if status == "approved":
            return PollApproved(_string(data, "agentId"), _string(data, "deviceToken"))
        raise PairingError("resposta da API fora do esperado")


async def probe_api(base_url: str, wait_seconds: float = 10.0) -> bool:
    """Confere se a API responde (rota anônima `devices/info`); não abre o canal do agente."""
    try:
        async with httpx.AsyncClient(timeout=wait_seconds) as client:
            response = await client.get(base_url.rstrip("/") + f"{_BASE}/info")
    except httpx.HTTPError:
        return False
    return response.status_code == HTTPStatus.OK
