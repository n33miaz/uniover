"""Rollout seguro: o agente só declara e envia o diagnóstico depois de a API dizer que o aceita."""

import asyncio
import json
from typing import Any

import httpx
import pytest

from tests.support import AGENT_ID, TOKEN, FakeApi
from uniover_agent.adapters import pairing_http
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition.connection import run
from uniover_agent.config import Settings
from uniover_agent.core import ConnectionSupervisor
from uniover_agent.core.api_features import (
    KEEPALIVE_LOOP_LAG_FEATURE,
    ApiFeatures,
    LoopLagGate,
)
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY

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


async def test_a_newly_listed_feature_fires_on_added_once() -> None:
    answers: list[frozenset[str] | None] = [
        frozenset(),
        frozenset({"x"}),
        frozenset({"x"}),
        None,
        frozenset({"x", "y"}),
    ]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    fired: list[bool] = []

    async def added() -> None:
        fired.append(True)

    features = ApiFeatures(fetch, FakeClock())
    features.on_added = added
    for expected in (0, 1, 1, 1, 2):  # nada novo, novo, igual, API dormindo, outro novo
        await features.refresh()
        assert len(fired) == expected


async def test_a_failing_on_added_never_breaks_the_refresh() -> None:
    async def fetch() -> frozenset[str] | None:
        return frozenset({"x"})

    async def added() -> None:
        raise RuntimeError("canal fechado")

    features = ApiFeatures(fetch, FakeClock())
    features.on_added = added
    await features.refresh()
    assert features.supports("x")


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
    # Sem resposta, volta logo e vai espaçando até o intervalo normal.
    assert clock.sleeps[:3] == [15, 30, 60]


async def test_once_the_api_answers_the_loop_goes_back_to_the_normal_interval() -> None:
    clock = FakeClock()

    async def fetch() -> frozenset[str] | None:
        return frozenset({"agent.diagnostics.v1"})

    task = asyncio.create_task(ApiFeatures(fetch, clock, interval=300).run())
    for _ in range(20):
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
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
        (httpx.Response(200, json={"module": "devices", "version": "1", "features": []}), set()),
        # Um 200 sem a lista (página de manutenção em JSON, resposta torta) NÃO é "a API não aceita
        # nada": é uma resposta que não diz nada.
        (httpx.Response(200, json={"module": "devices", "version": "1"}), None),
        (httpx.Response(200, json={"features": "nao-e-lista"}), None),
        (httpx.Response(200, json={}), None),
        (httpx.Response(200, json=[]), None),
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

    monkeypatch.setattr(connection_module, "fetch_api_features", api_features)

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


async def test_a_query_that_never_answers_does_not_hold_the_first_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def hangs(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        await asyncio.sleep(3600)
        return None

    monkeypatch.setattr(connection_module, "fetch_api_features", hangs)

    async def script(connection: Any) -> None:
        await asyncio.sleep(0.3)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        # O prazo é bem menor que o da consulta presa: se a conexão esperasse por ela, estouraria.
        await asyncio.wait_for(run(settings, lambda: store), timeout=15)
    hello = next(m for m in api.received if m["type"] == "agent.hello.v1")
    assert DIAGNOSTICS_CAPABILITY not in hello["body"]["capabilities"]


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


async def test_a_connection_made_before_the_api_answered_asks_again_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Partida sem rede: a primeira consulta falha. Ao conectar, o agente não espera o recuo (5 min):
    # consulta já, e o hello seguinte já declara a capacidade.
    calls: list[int] = []

    async def api_features(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        calls.append(1)
        return None if len(calls) == 1 else frozenset({DIAGNOSTICS_CAPABILITY})

    monkeypatch.setattr(connection_module, "fetch_api_features", api_features)

    async def script(connection: Any) -> None:
        await asyncio.sleep(0.6)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        await run(settings, lambda: store)

    hellos = [m for m in api.received if m["type"] == "agent.hello.v1"]
    assert len(calls) >= 2  # bem antes do recuo de 15 s da consulta de fundo
    assert DIAGNOSTICS_CAPABILITY in hellos[-1]["body"]["capabilities"]


@pytest.mark.parametrize(
    ("listed", "carries_lag"),
    [(frozenset({KEEPALIVE_LOOP_LAG_FEATURE}), True), (frozenset(), False), (None, False)],
)
async def test_the_loop_lag_rides_the_keepalive_only_to_an_api_that_lists_it(
    monkeypatch: pytest.MonkeyPatch, listed: frozenset[str] | None, carries_lag: bool
) -> None:
    # Uma API anterior recusaria cada batimento com o campo e, recusas seguidas, fecharia a
    # conexão: para ela (ou sem resposta ainda), o batimento sai vazio como sempre.
    class FastBeats(ConnectionSupervisor):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **{**kwargs, "keepalive_interval": 0.05})

    monkeypatch.setattr(connection_module, "ConnectionSupervisor", FastBeats)
    received = await _run_against_the_fake_api(monkeypatch, listed)

    beats = [m["body"] for m in received if m["type"] == "agent.keepalive.v1"]
    assert beats
    if carries_lag:
        assert any("loopLagMs" in body for body in beats)
        assert all(set(body) <= {"loopLagMs"} for body in beats)
    else:
        assert all(body == {} for body in beats)


def test_the_loop_lag_approval_belongs_to_the_connection_that_asked() -> None:
    gate = LoopLagGate()
    late = gate.checking()  # a consulta da conexão 0 ainda não voltou
    gate.connection_lost(refused=False)
    late()  # voltou depois da queda: não vale para a conexão nova
    assert not gate.allows()
    gate.checking()()
    assert gate.allows()
    gate.connection_lost(refused=False)
    assert not gate.allows()  # cada conexão consulta de novo


def test_a_policy_close_while_sending_the_loop_lag_keeps_the_next_connection_without_it() -> None:
    gate = LoopLagGate()
    gate.checking()()
    gate.sent()
    gate.connection_lost(refused=True)
    gate.checking()()
    assert not gate.allows()  # a conexão seguinte não manda, mesmo com a consulta dizendo que sim
    gate.connection_lost(refused=False)
    gate.checking()()
    assert gate.allows()


def test_a_policy_close_without_the_loop_lag_sent_blocks_nothing() -> None:
    gate = LoopLagGate()
    gate.checking()()
    gate.connection_lost(refused=True)
    gate.checking()()
    assert gate.allows()


async def test_an_api_that_closes_for_refusals_gets_the_next_connection_without_the_loop_lag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A consulta HTTP caiu na instância nova (lista o campo), mas o canal está na antiga, que recusa
    # o batimento com o campo e fecha por política (1008). A conexão seguinte não o manda.
    class FastBeats(ConnectionSupervisor):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **{**kwargs, "keepalive_interval": 0.05})

    monkeypatch.setattr(connection_module, "ConnectionSupervisor", FastBeats)

    async def api_features(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        return frozenset({KEEPALIVE_LOOP_LAG_FEATURE})

    monkeypatch.setattr(connection_module, "fetch_api_features", api_features)
    beats: list[tuple[int, dict[str, Any]]] = []
    connection_count = 0

    async def script(connection: Any) -> None:
        nonlocal connection_count
        connection_count += 1
        current = connection_count
        try:
            async with asyncio.timeout(3.0):
                async for raw in connection:
                    message = json.loads(raw)
                    if message["type"] != "agent.keepalive.v1":
                        continue
                    beats.append((current, message["body"]))
                    if current == 1 and "loopLagMs" in message["body"]:
                        await connection.close(1008, "policy")
                        return
                    if current == 2 and len([b for c, b in beats if c == 2]) >= 5:
                        break
        except TimeoutError:
            pass
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        await asyncio.wait_for(run(settings, lambda: store), timeout=20)

    assert any("loopLagMs" in body for c, body in beats if c == 1)
    second = [body for c, body in beats if c == 2]
    assert second
    assert all(body == {} for body in second)


async def test_a_refresh_says_whether_the_api_answered() -> None:
    answers: list[frozenset[str] | None] = [None, frozenset()]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())
    assert await features.refresh() is False
    assert await features.refresh() is True


async def test_listeners_hear_only_real_changes_of_what_the_api_accepts() -> None:
    answers: list[frozenset[str] | None] = [frozenset(), None, frozenset({"x"}), frozenset({"x"})]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())
    heard: list[bool] = []
    features.on_change(lambda: heard.append(features.supports("x")))
    await features.refresh()  # vazio igual ao desconhecido: nada mudou
    await features.refresh()  # API dormindo
    assert heard == []
    await features.refresh()  # a API passou a aceitar
    await features.refresh()  # a mesma lista de novo
    assert heard == [True]


async def test_a_failing_listener_never_breaks_the_refresh(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def fetch() -> frozenset[str] | None:
        return frozenset({"x"})

    features = ApiFeatures(fetch, FakeClock())

    def boom() -> None:
        raise RuntimeError("falhou")

    features.on_change(boom)
    await features.refresh()
    assert features.supports("x")
    assert "falha ao avisar" in caplog.text
