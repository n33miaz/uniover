"""Manutenção automática da Samsung só com TV, relógio e transporte falsos.

A TV é um `httpx.MockTransport` que responde como o REST da Samsung (`running` e `visible` por app)
e anota cada pedido. O driver é o de verdade: assim os testes provam o que sai pela rede, inclusive
que o canal do controle (o que faz a TV mostrar "Permitir") nunca é aberto.
"""

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.tv_samsung import SamsungClient, SamsungTvDriver
from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.samsung_apps import app_alias
from uniover_agent.core.tv.samsung_maintenance import (
    IDLE_SECONDS,
    SamsungMaintenance,
    SamsungMaintenanceScheduler,
)

AGENT_ID = "pc-tv"
YOUTUBE = "111299001912"
NETFLIX = "3201907018807"
PRIME = "3201910019365"

AppState = dict[str, Any]


class FakeTv:
    """Responde ao REST como a Samsung e guarda o que recebeu, na ordem."""

    def __init__(self, apps: dict[str, AppState]) -> None:
        self.apps = apps
        self.requests: list[tuple[str, str]] = []
        self.gets: dict[str, int] = {}
        self.on_get: Callable[[str, int], None] | None = None
        self.on_delete: Callable[[str], None] | None = None
        self.delete_status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        app_id = request.url.path.rsplit("/", 1)[-1]
        self.requests.append((request.method, app_id))
        if request.method == "GET":
            self.gets[app_id] = self.gets.get(app_id, 0) + 1
            if self.on_get is not None:
                self.on_get(app_id, self.gets[app_id])
            state = self.apps.get(app_id)
            if state is None:
                return httpx.Response(404)
            if state.get("error"):
                raise httpx.ConnectError("sem resposta")
            return httpx.Response(200, json={"id": app_id, "name": app_id, **state})
        if request.method == "DELETE":
            if self.on_delete is not None:
                self.on_delete(app_id)
            if self.delete_status == 200 and app_id in self.apps:
                self.apps[app_id]["running"] = False
            return httpx.Response(self.delete_status)
        return httpx.Response(405)

    @property
    def deleted(self) -> list[str]:
        return [app_id for method, app_id in self.requests if method == "DELETE"]


def hidden(running: bool = True) -> AppState:
    return {"running": running, "visible": False}


def shown() -> AppState:
    return {"running": True, "visible": True}


def make(  # noqa: PLR0913 - cada parte da cena é um parâmetro de teste
    apps: dict[str, AppState],
    *,
    power: bool | None = True,
    token: str | None = "guardado",  # noqa: S107
    permission_needed: bool = False,
    protected: tuple[str, ...] = (),
    configured: bool | None = True,
    deadline_seconds: float = 120.0,
) -> tuple[SamsungMaintenanceScheduler, FakeTv, FakeTransport, FakeClock, EnvelopeGate]:
    tv = FakeTv(apps)
    opened: list[str] = []

    def factory(host: str, token_value: str | None, name: str) -> SamsungClient:
        opened.append(host)
        raise AssertionError("a manutenção não pode abrir o canal do controle")

    async def read_power(host: str) -> bool | None:
        del host
        return power

    async def request_token(current: str | None) -> str:
        del current
        raise AssertionError("a manutenção não pode pedir permissão à TV")

    driver = SamsungTvDriver(
        "192.168.0.11",
        token,
        "UniOver",
        factory=factory,
        fetch_power=read_power,
        permission_needed=permission_needed,
        request_token=request_token,
        rest_transport=httpx.MockTransport(tv.handler),
    )
    clock = FakeClock()
    transport = FakeTransport()
    gate = EnvelopeGate(AGENT_ID)
    scheduler = SamsungMaintenanceScheduler(
        SamsungMaintenance(
            driver, clock, lambda: set(protected), deadline_seconds=deadline_seconds
        ),
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, gate, clock),
    )
    if configured is not None:
        scheduler.configure(configured)
    return scheduler, tv, transport, clock, gate


async def idle_period(scheduler: SamsungMaintenanceScheduler, clock: FakeClock) -> None:
    scheduler.note_message("tv.app.launch.v1")
    clock.advance(IDLE_SECONDS)
    await scheduler.run_pending()


def bodies(transport: FakeTransport) -> list[dict[str, Any]]:
    return [message["body"] for message in transport.sent]


async def test_closes_only_the_apps_the_tv_says_are_running_in_the_background() -> None:
    scheduler, tv, transport, clock, gate = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden(), "3201606009684": hidden(False)}
    )

    await idle_period(scheduler, clock)

    assert sorted(tv.deleted) == sorted([NETFLIX, PRIME])
    body = bodies(transport)[0]
    assert (body["result"], body["closedApps"], body["trigger"], body["kind"]) == (
        "completed",
        2,
        "maintenance",
        "deep",
    )
    assert sorted(body["closedPackages"]) == sorted([app_alias(NETFLIX), app_alias(PRIME)])
    for message in transport.sent:
        gate.check_outbound(message)


async def test_a_visible_app_is_never_closed() -> None:
    scheduler, tv, _, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    await idle_period(scheduler, clock)

    assert YOUTUBE not in tv.deleted
    assert tv.deleted == [NETFLIX]


async def test_the_last_app_opened_by_the_user_is_never_closed_even_if_the_tv_says_hidden() -> None:
    # A TV pode estar numa entrada HDMI ou na tela inicial por cima do app: protegido assim mesmo.
    scheduler, tv, _, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden()}, protected=(NETFLIX,)
    )

    await idle_period(scheduler, clock)

    assert tv.deleted == [PRIME]


@pytest.mark.parametrize(
    "apps",
    [
        pytest.param({YOUTUBE: hidden(), NETFLIX: hidden()}, id="nenhum-app-visivel"),
        pytest.param({YOUTUBE: shown(), NETFLIX: shown(), PRIME: hidden()}, id="dois-visiveis"),
        pytest.param({YOUTUBE: {"running": True}, NETFLIX: hidden()}, id="campo-visible-ausente"),
        pytest.param(
            {YOUTUBE: {"running": True, "visible": "true"}, NETFLIX: hidden()},
            id="visible-nao-booleano",
        ),
        pytest.param({YOUTUBE: {"error": True}, NETFLIX: hidden()}, id="leitura-do-visivel-falhou"),
        pytest.param({}, id="tv-sem-nenhum-app-conhecido"),
    ],
)
async def test_doubt_about_the_app_in_use_skips_the_whole_run(apps: dict[str, AppState]) -> None:
    scheduler, tv, transport, clock, _ = make(apps)

    await idle_period(scheduler, clock)

    assert tv.deleted == []
    body = bodies(transport)[0]
    assert (body["result"], body["reason"], body["closedApps"]) == (
        "skipped",
        "foreground-unverifiable",
        0,
    )


async def test_the_app_in_use_changing_between_the_two_readings_skips_the_run() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    def switch(app_id: str, count: int) -> None:
        # Entre as duas leituras a pessoa trocou de app com o controle físico.
        if app_id == NETFLIX and count == 2:
            tv.apps[YOUTUBE]["visible"] = False
            tv.apps[NETFLIX]["visible"] = True

    tv.on_get = switch
    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert bodies(transport)[0]["reason"] == "foreground-unverifiable"


async def test_an_app_that_becomes_visible_just_before_its_closing_is_not_closed() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    def open_it(app_id: str, count: int) -> None:
        # Terceira leitura do Netflix: a conferência de logo antes do fechamento.
        if app_id == NETFLIX and count == 3:
            tv.apps[NETFLIX]["visible"] = True

    tv.on_get = open_it
    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert bodies(transport)[0]["closedApps"] == 0


async def test_activity_during_the_run_stops_before_closing_anything() -> None:
    scheduler, tv, transport, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden()}
    )

    def touch(app_id: str, count: int) -> None:
        if app_id == NETFLIX and count == 2:
            scheduler.note_message("tv.key.v3")

    tv.on_get = touch
    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert bodies(transport)[0]["reason"] == "recent-command"


async def test_only_successful_deletes_are_counted() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})
    tv.delete_status = 500

    await idle_period(scheduler, clock)

    assert tv.deleted == [NETFLIX]
    assert bodies(transport)[0]["closedApps"] == 0


@pytest.mark.parametrize(
    ("token", "permission_needed"),
    [(None, False), ("guardado", True), (None, True)],
    ids=["sem-token", "tv-pediu-permissao-de-novo", "sem-token-e-marcada"],
)
async def test_without_a_valid_permission_the_tv_is_not_touched_and_the_owner_hears_once(
    token: str | None, permission_needed: bool
) -> None:
    scheduler, tv, transport, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden()}, token=token, permission_needed=permission_needed
    )

    await idle_period(scheduler, clock)
    await idle_period(scheduler, clock)

    # Nenhum pedido, nem de leitura: `factory` e `request_token` do cenário reprovam se usados.
    assert tv.requests == []
    assert [(body["result"], body["reason"]) for body in bodies(transport)] == [
        ("skipped", "permission-required")
    ]


async def test_a_tv_that_is_off_is_not_probed_and_nothing_is_reported() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()}, power=False)

    await idle_period(scheduler, clock)

    assert tv.requests == []
    assert transport.sent == []


async def test_a_tv_that_does_not_answer_about_power_skips_without_probing() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()}, power=None)

    await idle_period(scheduler, clock)

    assert tv.requests == []
    assert bodies(transport)[0]["reason"] == "state-unavailable"


async def test_nothing_runs_before_the_idle_time_or_without_the_option() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})
    scheduler.note_message("tv.app.launch.v1")
    clock.advance(IDLE_SECONDS - 1)
    await scheduler.run_pending()
    assert (tv.requests, transport.sent) == ([], [])

    off, off_tv, off_transport, off_clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden()}, configured=False
    )
    await idle_period(off, off_clock)
    assert (off_tv.requests, off_transport.sent) == ([], [])

    waiting, waiting_tv, waiting_transport, waiting_clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden()}, configured=None
    )
    await idle_period(waiting, waiting_clock)
    assert (waiting_tv.requests, waiting_transport.sent) == ([], [])


async def test_only_use_by_the_owner_arms_the_timer() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    scheduler.note_message("agent.keepalive.v1")
    clock.advance(IDLE_SECONDS)
    await scheduler.run_pending()

    assert (tv.requests, transport.sent) == ([], [])


async def test_one_run_per_idle_period_and_the_same_skip_is_reported_once() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: hidden(), NETFLIX: hidden()})

    await idle_period(scheduler, clock)
    await scheduler.run_pending()  # nada novo: o período já foi usado
    await idle_period(scheduler, clock)  # mesma dúvida de novo: não vira outra linha

    assert [body["reason"] for body in bodies(transport)] == ["foreground-unverifiable"]

    tv.apps[YOUTUBE] = shown()
    await idle_period(scheduler, clock)
    assert [body["result"] for body in bodies(transport)] == ["skipped", "completed"]


async def test_the_configuration_can_turn_it_off_again() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})
    scheduler.note_message("tv.key.v3")
    scheduler.configure(False)
    clock.advance(IDLE_SECONDS)
    await scheduler.run_pending()
    assert (tv.requests, transport.sent) == ([], [])


async def test_activity_after_the_first_closing_keeps_that_count_and_stops_the_rest() -> None:
    scheduler, tv, transport, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden()}
    )
    tv.on_delete = lambda _app_id: scheduler.note_message("tv.key.v3")

    await idle_period(scheduler, clock)

    assert len(tv.deleted) == 1
    body = bodies(transport)[0]
    assert (body["result"], body["closedApps"]) == ("completed", 1)


async def test_the_timer_loop_survives_a_failing_run_and_stops_on_close() -> None:
    scheduler, tv, transport, _, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    class Boom:
        async def run(self, may_continue: Callable[[], bool]) -> Any:
            del may_continue
            raise RuntimeError("falha inesperada")

    real = scheduler._maintenance
    scheduler._maintenance = Boom()  # type: ignore[assignment]
    loop = asyncio.create_task(scheduler.run())
    scheduler.note_message("tv.key.v3")
    for _ in range(20):
        await asyncio.sleep(0)

    # A falha não matou o laço: o uso seguinte, com a manutenção boa de volta, é atendido.
    assert not loop.done()
    scheduler._maintenance = real
    scheduler.note_message("tv.key.v3")
    for _ in range(40):
        await asyncio.sleep(0)
    assert tv.deleted == [NETFLIX]
    assert bodies(transport)[0]["closedApps"] == 1

    await scheduler.aclose()
    await asyncio.wait_for(loop, timeout=1)


async def test_activity_that_arrives_during_the_last_reading_stops_the_closing() -> None:
    # A corrida da revisão: o comando chega enquanto a conferência final da TV está em andamento.
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    def touch(app_id: str, count: int) -> None:
        if app_id == NETFLIX and count == 3:
            scheduler.note_message("tv.key.v3")

    tv.on_get = touch
    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert bodies(transport)[0]["reason"] == "recent-command"


async def test_turning_the_option_off_during_the_last_reading_cancels_the_run() -> None:
    scheduler, tv, transport, clock, _ = make({YOUTUBE: shown(), NETFLIX: hidden()})

    def turn_off(app_id: str, count: int) -> None:
        if app_id == NETFLIX and count == 3:
            scheduler.configure(False)

    tv.on_get = turn_off
    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert transport.sent == []


async def test_turning_the_option_off_after_a_closing_stops_the_rest_and_keeps_the_count() -> None:
    scheduler, tv, transport, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden()}
    )
    tv.on_delete = lambda _app_id: scheduler.configure(False)

    await idle_period(scheduler, clock)

    assert len(tv.deleted) == 1
    body = bodies(transport)[0]
    assert (body["result"], body["closedApps"]) == ("completed", 1)


async def test_the_whole_run_has_a_deadline_and_closes_nothing_past_it() -> None:
    scheduler, tv, transport, clock, _ = make(
        {YOUTUBE: shown(), NETFLIX: hidden(), PRIME: hidden()}, deadline_seconds=0.0
    )

    await idle_period(scheduler, clock)

    assert tv.deleted == []
    assert bodies(transport)[0]["reason"] == "state-unavailable"
