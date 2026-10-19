import json
from collections.abc import Callable

import httpx
import pytest

from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
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
    PollSlowDown,
)

INFO = PairingInfo("PC da sala", "Windows 11", "0.1.0")
TICKET = PairingTicket("0192f1e4-0000-7000-8000-000000000001", "DEVICE-CODE", "ABCD-2345", 600, 5)
BASE = "https://api.exemplo.test"


def client_with(handler: Callable[[httpx.Request], httpx.Response]) -> HttpPairingClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HttpPairingClient(BASE, http)


async def test_start_sends_camel_case_body_and_parses_ticket() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "pairingId": TICKET.pairing_id,
                "deviceCode": "DEVICE-CODE",
                "userCode": "ABCD-2345",
                "expiresIn": 600,
                "interval": 5,
            },
        )

    ticket = await client_with(handler).start(INFO)
    assert ticket == TICKET
    assert str(seen[0].url) == f"{BASE}/api/v1/devices/pairing/start"
    assert json.loads(seen[0].content) == {
        "agentName": "PC da sala",
        "platform": "Windows 11",
        "agentVersion": "0.1.0",
    }
    assert "authorization" not in seen[0].headers


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"status": "pending"}, PollPending()),
        ({"status": "slow_down", "interval": 10}, PollSlowDown(10)),
        (
            {"status": "approved", "agentId": "pc-da-sala", "deviceToken": "uo_dev_x"},
            PollApproved("pc-da-sala", "uo_dev_x"),
        ),
    ],
)
async def test_poll_statuses(payload: dict[str, object], expected: object) -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=payload)

    result = await client_with(handler).poll(TICKET)
    assert result == expected
    assert seen == [{"pairingId": TICKET.pairing_id, "deviceCode": "DEVICE-CODE"}]


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (404, PairingNotFound),
        (410, PairingExpired),
        (403, PairingDenied),
        (429, PairingRateLimited),
        (503, PairingUnavailable),
        (400, PairingError),
    ],
)
async def test_poll_error_codes(status: int, error: type[Exception]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, headers={"Retry-After": "7"}, json={"title": "x"})

    with pytest.raises(error) as caught:
        await client_with(handler).poll(TICKET)
    assert "DEVICE-CODE" not in str(caught.value)
    if isinstance(caught.value, PairingRateLimited):
        assert caught.value.retry_after == 7


async def test_start_429_carries_retry_after() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "30"})

    with pytest.raises(PairingRateLimited) as caught:
        await client_with(handler).start(INFO)
    assert caught.value.retry_after == 30


async def test_network_failure_is_unavailable_not_fatal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rota", request=request)

    with pytest.raises(PairingUnavailable):
        await client_with(handler).poll(TICKET)


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "desconhecido"},
        {"status": "approved", "agentId": "x"},
        {"status": "slow_down"},
        {},
    ],
)
async def test_unexpected_payload_is_an_error(payload: dict[str, object]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with pytest.raises(PairingError):
        await client_with(handler).poll(TICKET)


async def test_non_json_body_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>")

    with pytest.raises(PairingError):
        await client_with(handler).start(INFO)


async def test_probe_api_returns_false_when_unreachable() -> None:
    assert await probe_api("http://127.0.0.1:1", wait_seconds=1.0) is False
