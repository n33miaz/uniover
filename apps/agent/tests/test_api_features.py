"""Rollout seguro: o agente só declara e envia o diagnóstico depois de a API dizer que o aceita."""

import asyncio
import json
from typing import Any

import httpx
import pytest

from tests.support import AGENT_ID, TOKEN, FakeApi
from uniover_agent import main as main_module
from uniover_agent.adapters import pairing_http
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.config import Settings
from uniover_agent.core.api_features import ApiFeatures
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY
from uniover_agent.main import run

# --- ApiFeatures --------------------------------------------------------------------------------


async def test_a_feature_is_unknown_until_the_api_lists_it() -> None:
    answers: list[frozenset[str] | None] = [None, frozenset(), frozenset({"agent.diagnostics.v1"})]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())
    assert not features.supports("agent.diagnostics.v1")
    await features.refresh()  # API dormindo
    assert not features.supports("agent.diagnostics.v1")
    await features.refresh()  # API antiga: responde, sem o campo
    assert not features.supports("agent.diagnostics.v1")
    await features.refresh()  # API nova
    assert features.supports("agent.diagnostics.v1")


async def test_a_silent_api_does_not_erase_what_was_already_known_and_an_old_one_does() -> None:
    answers: list[frozenset[str] | None] = [frozenset({"x"}), None, frozenset()]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())
    await features.refresh()
    await features.refresh()
    assert features.supports("x")
    # Uma API que voltou a uma versão anterior deixa de ser tratada como se aceitasse.
    await features.refresh()
    assert not features.supports("x")


async def test_a_failing_fetch_is_logged_and_never_raises() -> None:
    async def fetch() -> frozenset[str] | None:
        raise RuntimeError("falha")

    features = ApiFeatures(fetch, FakeClock())
    await features.refresh()
    assert not features.supports("x")


async def test_the_loop_asks_again_every_interval() -> None:
    clock = FakeClock()
    calls: list[int] = []

    async def fetch() -> frozenset[str] | None:
        calls.append(1)
        return None

    task = asyncio.create_task(ApiFeatures(fetch, clock, interval=300).run())
    for _ in range(20):
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert len(calls) >= 2
    assert clock.sleeps[:2] == [300, 300]


# --- fetch_api_features -------------------------------------------------------------------------


def _client_answering(response: httpx.Response | Exception) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/devices/info"
        if isinstance(response, Exception):
            raise response
        return response

    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real(*args, **kwargs)

    return factory


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            httpx.Response(200, json={"module": "devices", "version": "1", "features": ["a", "b"]}),
            {"a", "b"},
        ),
        (httpx.Response(200, json={"module": "devices", "version": "1"}), set()),
        (httpx.Response(200, json={"features": "nao-e-lista"}), set()),
        (httpx.Response(200, json={"features": ["a", 7, None]}), {"a"}),
        (httpx.Response(503), None),
        (httpx.Response(200, content=b"nao json"), None),
        (httpx.ConnectError("sem rede"), None),
    ],
)
async def test_the_features_are_read_from_the_public_info_route(
    monkeypatch: pytest.MonkeyPatch, response: httpx.Response | Exception, expected: set[str] | None
) -> None:
    monkeypatch.setattr(httpx, "AsyncClient", _client_answering(response))
    found = await pairing_http.fetch_api_features("https://api.exemplo.com/")
    assert found == (None if expected is None else frozenset(expected))


# --- composição: o hello e o envio seguem o que a API disse ---------------------------------------


async def _run_against_the_fake_api(
    monkeypatch: pytest.MonkeyPatch, features: frozenset[str] | None
) -> list[dict[str, Any]]:
    async def api_features(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        return features

    monkeypatch.setattr(main_module, "fetch_api_features", api_features)

    async def script(connection: Any) -> None:
        await asyncio.sleep(0.3)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        await run(settings, lambda: store)
    return [json.loads(json.dumps(message)) for message in api.received]


async def test_an_api_that_does_not_list_diagnostics_gets_a_hello_without_it_and_no_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received = await _run_against_the_fake_api(monkeypatch, frozenset())
    hello = next(m for m in received if m["type"] == "agent.hello.v1")
    assert DIAGNOSTICS_CAPABILITY not in hello["body"]["capabilities"]
    assert all(m["type"] != "agent.diagnostics.v1" for m in received)


async def test_an_api_that_cannot_be_asked_yet_is_treated_the_same_way(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received = await _run_against_the_fake_api(monkeypatch, None)
    hello = next(m for m in received if m["type"] == "agent.hello.v1")
    assert DIAGNOSTICS_CAPABILITY not in hello["body"]["capabilities"]
    assert all(m["type"] != "agent.diagnostics.v1" for m in received)


async def test_an_api_that_lists_diagnostics_gets_the_capability_and_the_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received = await _run_against_the_fake_api(monkeypatch, frozenset({DIAGNOSTICS_CAPABILITY}))
    hello = next(m for m in received if m["type"] == "agent.hello.v1")
    assert DIAGNOSTICS_CAPABILITY in hello["body"]["capabilities"]
    assert any(m["type"] == "agent.diagnostics.v1" for m in received)
