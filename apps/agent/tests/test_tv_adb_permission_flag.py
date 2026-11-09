"""Permissão do ADB contada ao app: IP novo da mesma TV, motivo da recusa e o estado enviado.

Nenhum teste fala com uma TV nem roda o `adb`: a chave, a pasta de instalação e o MAC são de mentira
e o processo é o `FakeAdbRunner`. O agente nunca abre um aviso sozinho: os testes do portão conferem
que nenhum `adb connect` sai.
"""

import asyncio
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.adb_authorization import (
    GATE_MAC_UNKNOWN,
    GATE_NEVER,
    GATE_UNPROVEN,
    NEEDS_USER,
    VERIFIED,
)
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.core import EnvelopeFactory, EnvelopeGate, TvState, TvStatePublisher
from uniover_agent.core.tv.adb_permission import AdbPermissionTracker
from uniover_agent.ports import (
    AdbDeviceChanged,
    AdbPermissionState,
    AdbUnauthorized,
    AdbUnreachable,
    user_initiated_adb,
)

from .support import AGENT_ID
from .support_adb import (
    CONNECT,
    DISCONNECT,
    GET_STATE,
    SERIAL,
    FakeAdbRunner,
    ok,
    shell,
)
from .test_tv_adb import Clock
from .test_tv_adb_permission import (
    DEVICE,
    ENDPOINT,
    FRESH,
    MAC,
    OTHER_MAC,
    PAIRING,
    REFUSED,
    UNAUTHORIZED,
    UNKNOWN,
    Home,
    instant,
    runner_with,
    watched,
)

NEW_ENDPOINT = "192.168.1.99:5555"  # o roteador deu outro IP à TV depois da queda de luz


class Sink:
    """Quem ouve o adaptador: guarda (estado, motivo, detalhe) na ordem."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, str]] = []

    def report(self, state: AdbPermissionState, reason: str, detail: str = "") -> None:
        self.events.append((state, reason, detail))

    @property
    def last(self) -> tuple[str, str]:
        state, reason, _ = self.events[-1]
        return state, reason


@pytest.fixture
def home(tmp_path: Path) -> Home:
    house = Home(tmp_path)
    house.write_key()
    return house


def listening(home: Home, runner: FakeAdbRunner, sink: Sink, **extra: Any) -> AdbTv:
    return home.adb(runner, permission=sink, **extra)


# --- a mesma TV com IP novo: a permissão vai junto (o MAC identifica o aparelho) ---


async def test_the_same_tv_at_a_new_address_keeps_its_permission(home: Home) -> None:
    home.verify(settled=True)
    moved = home.authorization(NEW_ENDPOINT)
    before = moved.record
    runner = runner_with()
    await home.adb(runner, authorization=moved).connect()
    # Conectou sozinho (sem aviso): a TV guarda a chave, e o registro passou para o endereço novo.
    assert runner.calls == [CONNECT, GET_STATE]
    after = home.authorization(NEW_ENDPOINT).record
    assert after.endpoint == NEW_ENDPOINT
    assert after.state == VERIFIED
    assert after.timeout_disabled == before.timeout_disabled is True
    assert after.fingerprint == before.fingerprint
    assert after.mac == MAC


async def test_another_device_at_the_new_address_is_refused_without_saying_missing(
    home: Home,
) -> None:
    home.verify()
    home.mac = OTHER_MAC
    sink = Sink()
    moved = home.authorization(NEW_ENDPOINT)
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbDeviceChanged):
        await listening(home, runner, sink, authorization=moved).connect()
    assert CONNECT not in runner.calls
    # Não é falta de permissão: o app não deve pedir nada a quem não é a TV.
    assert sink.events == []
    assert home.authorization().record.endpoint == ENDPOINT  # o registro não foi levado


async def test_a_new_address_without_a_readable_mac_never_adopts(home: Home) -> None:
    home.verify()
    home.mac = ""  # a porta abre, mas a ARP não mostra o aparelho (VPN, outra sub-rede)
    sink = Sink()
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await listening(
            home, runner, sink, authorization=home.authorization(NEW_ENDPOINT)
        ).connect()
    assert CONNECT not in runner.calls
    assert sink.last == ("missing", GATE_MAC_UNKNOWN)


async def test_a_tv_that_does_not_answer_at_the_new_address_is_unreachable_not_unauthorized(
    home: Home,
) -> None:
    home.verify()
    home.mac = None  # desligada: não dá para saber se é a mesma TV, e conectar não adiantaria
    sink = Sink()
    runner = runner_with()
    with pytest.raises(AdbUnreachable):
        await listening(
            home, runner, sink, authorization=home.authorization(NEW_ENDPOINT)
        ).connect()
    assert runner.calls == []
    assert sink.events == []  # TV desligada não é "sem permissão"


async def test_a_users_request_at_a_new_address_may_still_connect_and_adopts_the_record(
    home: Home,
) -> None:
    home.verify(settled=True)
    moved = home.authorization(NEW_ENDPOINT)
    runner = runner_with()
    with user_initiated_adb():
        await home.adb(runner, authorization=moved).connect()
    assert home.authorization(NEW_ENDPOINT).record.endpoint == NEW_ENDPOINT
    assert home.authorization(NEW_ENDPOINT).record.state == VERIFIED


# --- por que o portão fechou: cada motivo vai ao app ---


async def test_without_a_record_the_gate_reports_missing_never(home: Home) -> None:
    sink = Sink()
    with pytest.raises(AdbUnauthorized):
        await listening(home, runner_with(state=UNKNOWN), sink).connect()
    assert sink.last == ("missing", GATE_NEVER)


async def test_a_granted_but_unproven_record_reports_unproven(home: Home) -> None:
    authorization = home.authorization()
    assert authorization.mark_granted(authorization.snapshot_key(), MAC)
    sink = Sink()
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await listening(home, runner, sink).connect()
    assert CONNECT not in runner.calls
    assert sink.last == ("missing", GATE_UNPROVEN)


async def test_an_idle_agent_reports_nothing_because_the_tv_did_not_refuse(home: Home) -> None:
    home.verify()
    home.active = False
    sink = Sink()
    with pytest.raises(Exception, match="ADB"):
        await listening(home, runner_with(), sink).connect()
    assert sink.events == []


async def test_the_same_reason_is_not_repeated_on_every_tap(home: Home) -> None:
    sink = Sink()
    clock = Clock()
    adb = home.adb(runner_with(state=UNKNOWN), clock, permission=sink)
    for _ in range(3):
        clock.now += 31
        with pytest.raises(AdbUnauthorized):
            await adb.connect()
    assert [event[:2] for event in sink.events] == [("missing", GATE_NEVER)]


# --- a TV recusou a chave: aviso na TV (pending), aceite (granted), janela vencida (missing) ---


async def test_a_prompt_on_the_tv_is_pending_until_the_accept(home: Home) -> None:
    sink = Sink()
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = listening(home, runner, sink, sleep=instant, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    assert sink.last == ("pending", "prompt_on_tv")
    await watched(adb)
    assert [event[:2] for event in sink.events] == [
        ("pending", "prompt_on_tv"),
        ("granted", "accepted"),
    ]


async def test_a_prompt_nobody_accepts_ends_as_missing(home: Home) -> None:
    clock = Clock()

    async def slow(seconds: float) -> None:
        del seconds
        clock.now += 100  # cada espera passa da janela de 90 s
        await asyncio.sleep(0)

    sink = Sink()
    runner = runner_with(state=[UNAUTHORIZED, DEVICE])
    adb = home.adb(
        runner,
        clock,
        sleep=slow,
        pairing_watch_seconds=90.0,
        pairing_poll_seconds=3.0,
        permission=sink,
    )
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    assert [event[:2] for event in sink.events] == [
        ("pending", "prompt_on_tv"),
        ("missing", "prompt_expired"),
    ]


async def test_a_retry_while_the_prompt_is_on_the_tv_never_flips_back_to_missing(
    home: Home,
) -> None:
    forever = asyncio.Event()

    async def never(seconds: float) -> None:
        del seconds
        await forever.wait()

    sink = Sink()
    clock = Clock()
    adb = home.adb(runner_with(state=UNAUTHORIZED), clock, sleep=never, permission=sink, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    clock.now += 31
    with pytest.raises(AdbUnauthorized):
        await adb.connect()  # o mesmo bloqueio de 30 s, pelo portão: a espera do aceite segue
    assert sink.last == ("pending", "prompt_on_tv")
    await adb.aclose()


async def test_losing_a_proven_permission_is_told_as_the_tv_forgetting_it(home: Home) -> None:
    home.verify(settled=True)
    sink = Sink()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await listening(home, runner, sink).connect()
    state, reason, detail = sink.events[-1]
    assert (state, reason) == ("missing", "tv_forgot")
    assert "verified" in detail  # o registro dizia que estava provada
    assert home.authorization().record.state == NEEDS_USER
    assert DISCONNECT in runner.calls  # e o agente desfaz a conexão sem esperar aviso


async def test_a_prompt_with_no_watch_window_ends_right_away_as_missing(home: Home) -> None:
    # Sem janela de espera (0 s) o aviso nasce e acaba no mesmo toque: o app sabe que acabou.
    sink = Sink()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = listening(home, runner, sink)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.connect()
    await watched(adb)
    assert [event[:2] for event in sink.events] == [
        ("pending", "prompt_on_tv"),
        ("missing", "prompt_expired"),
    ]


async def test_a_connection_that_reaches_device_reports_granted(home: Home) -> None:
    home.verify(settled=True)
    sink = Sink()
    await listening(home, runner_with(), sink).connect()
    assert sink.last == ("granted", "connected")


async def test_a_failing_listener_never_breaks_the_adb_channel(home: Home) -> None:
    class Broken:
        def report(self, state: AdbPermissionState, reason: str, detail: str = "") -> None:
            raise RuntimeError("falha do ouvinte")

    home.verify(settled=True)
    runner = runner_with()
    await home.adb(runner, permission=Broken()).connect()
    assert runner.calls == [CONNECT, GET_STATE]


# --- o pedido da pessoa e a recusa guardada; shell e cópia; sondar a rede só se vale ---


async def test_a_users_request_after_an_automatic_refusal_really_connects(home: Home) -> None:
    home.verify(settled=True)
    sink = Sink()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = listening(home, runner, sink, sleep=instant, **PAIRING)
    with pytest.raises(AdbUnauthorized):
        await adb.list_apps()  # caminho automático: a TV recusou a chave, e a recusa fica guardada
    assert runner.calls.count(CONNECT) == 1
    # Dentro dos 30 s do cache: o pedido da pessoa não pode ficar preso nele.
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    assert runner.calls.count(CONNECT) == 2  # conectou de verdade
    assert sink.last == ("pending", "prompt_on_tv")
    await adb.aclose()


async def test_an_automatic_path_keeps_hitting_the_stored_refusal(home: Home) -> None:
    home.verify(settled=True)
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = home.adb(runner)
    with pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    with pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1  # nenhum aviso novo sem toque


async def test_a_second_tap_while_the_prompt_is_on_the_tv_does_not_connect_again(
    home: Home,
) -> None:
    forever = asyncio.Event()

    async def never(seconds: float) -> None:
        del seconds
        await forever.wait()

    home.verify(settled=True)
    sink = Sink()
    runner = runner_with(connect=REFUSED, state=UNKNOWN)
    adb = listening(home, runner, sink, sleep=never, **PAIRING)
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    with user_initiated_adb(), pytest.raises(AdbUnauthorized):
        await adb.list_apps()
    assert runner.calls.count(CONNECT) == 1  # o aviso já está na tela
    assert sink.last == ("pending", "prompt_on_tv")
    await adb.aclose()


async def test_a_refusal_found_by_a_shell_command_is_told_as_the_tv_forgetting(
    home: Home,
) -> None:
    home.verify(settled=True)
    sink = Sink()
    runner = runner_with()
    memory = shell("grep MemAvailable /proc/meminfo")
    runner.script[memory] = ok("error: device unauthorized.\r\n", returncode=1)
    adb = listening(home, runner, sink)
    await adb.connect()
    assert sink.last == ("granted", "connected")
    with pytest.raises(AdbUnauthorized):
        await adb.memory_available_mb()
    state, reason, detail = sink.events[-1]
    assert (state, reason) == ("missing", "tv_forgot")  # nada de `granted` velho fechando a folha
    assert "verified" in detail
    assert home.authorization().record.state == NEEDS_USER


async def test_a_refusal_found_while_copying_an_apk_is_told_too(home: Home) -> None:
    home.verify(settled=True)
    sink = Sink()
    runner = runner_with()
    remote = "/data/app/x/base.apk"
    local = home.state / "x.apk"
    runner.script[("-s", SERIAL, "pull", remote, str(local))] = ok(
        "error: device unauthorized.\r\n", returncode=1
    )
    adb = listening(home, runner, sink)
    await adb.connect()
    with pytest.raises(AdbUnauthorized):
        await adb.pull_apk(remote, local)
    assert sink.last == ("missing", "tv_forgot")


async def test_the_network_is_only_probed_when_adopting_is_possible(home: Home) -> None:
    # Registro sem MAC anotado: não há o que adotar, então nada de sondar a rede no caminho rápido.
    authorization = home.authorization()
    assert authorization.mark_verified(authorization.snapshot_key(), "")
    home.reads = 0
    runner = runner_with(state=UNKNOWN)
    with pytest.raises(AdbUnauthorized):
        await home.adb(runner, authorization=home.authorization(NEW_ENDPOINT)).connect()
    assert home.reads == 0
    assert runner.calls == [GET_STATE]


async def test_a_tv_that_is_off_costs_the_person_no_probe_and_no_cached_unreachable(
    home: Home,
) -> None:
    # Sem MAC anotado e a TV desligada: o pedido da pessoa não esbarra num `AdbUnreachable`
    # guardado por uma sondagem que nem poderia adotar nada.
    authorization = home.authorization()
    assert authorization.mark_verified(authorization.snapshot_key(), "")
    home.mac = None
    moved = home.authorization(NEW_ENDPOINT)
    runner = runner_with(connect=FRESH, state=[UNKNOWN, DEVICE])
    adb = home.adb(runner, authorization=moved)
    with pytest.raises(AdbUnauthorized):
        await adb.connect()  # automático: o portão, sem sondar nada
    with user_initiated_adb():
        await adb.connect()
    assert CONNECT in runner.calls


async def test_a_device_swap_needs_two_known_macs(home: Home) -> None:
    home.verify()
    authorization = home.authorization()
    assert authorization.another_device_at(OTHER_MAC)
    assert not authorization.another_device_at(MAC)
    assert not authorization.another_device_at("")
    assert not authorization.another_device_at(None)


# --- o estado guardado, o diagnóstico e o campo do `tv.state.v1` ---


def test_the_tracker_tells_listeners_when_the_state_or_the_reason_changes() -> None:
    tracker = AdbPermissionTracker()
    written: list[tuple[str, str, str]] = []
    tracker.record_with(lambda kind, severity, detail: written.append((kind, severity, detail)))
    heard: list[str | None] = []
    tracker.on_change(lambda: heard.append(tracker.state))

    tracker.report("missing", "never")
    tracker.report("missing", "never")  # igual: nada de novo
    tracker.report("missing", "address_changed", "detalhe")  # só o motivo mudou
    tracker.report("pending", "prompt_on_tv")
    tracker.report("granted", "accepted")

    # Só o motivo mudou (missing: never para missing: address_changed): o app também fica sabendo.
    assert heard == ["missing", "missing", "pending", "granted"]
    assert [item[0] for item in written] == [
        "adb.permission.missing",
        "adb.permission.missing",
        "adb.permission.pending",
        "adb.permission.granted",
    ]
    assert written[0][1] == "warn" and written[2][1] == "info"
    assert "address_changed" in written[1][2] and "detalhe" in written[1][2]
    assert tracker.state == "granted"
    assert tracker.reason == "accepted"


def test_the_tracker_survives_a_failing_listener_and_a_failing_recorder() -> None:
    tracker = AdbPermissionTracker()

    def bad_recorder(kind: str, severity: Any, detail: str) -> None:
        raise RuntimeError("diagnóstico")

    def bad_listener() -> None:
        raise RuntimeError("ouvinte")

    tracker.record_with(bad_recorder)
    tracker.on_change(bad_listener)
    heard: list[str | None] = []
    tracker.on_change(lambda: heard.append(tracker.state))
    tracker.report("missing", "never")
    assert heard == ["missing"]


def make_publisher(
    tracker: AdbPermissionTracker, *, supported: bool
) -> tuple[TvStatePublisher, FakeTransport]:
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())
    return (
        TvStatePublisher(
            transport,
            envelopes,
            reports_adb_permission=lambda: supported,
            adb_permission=lambda: tracker.state,
            adb_permission_reason=lambda: tracker.reason,
        ),
        transport,
    )


async def test_the_state_carries_the_adb_permission_for_an_api_that_accepts_it() -> None:
    tracker = AdbPermissionTracker()
    publisher, transport = make_publisher(tracker, supported=True)
    await publisher.announce(TvState("on", 10, None, "hot"))  # ainda sem dizer nada
    tracker.report("missing", "unproven")
    await publisher.announce(TvState("on", 10, None, "hot"))
    assert "adbPermission" not in transport.sent[0]["body"]
    assert transport.sent[1]["body"]["adbPermission"] == "missing"
    assert transport.sent[1]["type"] == "tv.state.v1"


async def test_an_older_api_gets_the_state_exactly_as_before() -> None:
    tracker = AdbPermissionTracker()
    tracker.report("pending", "prompt_on_tv")
    publisher, transport = make_publisher(tracker, supported=False)
    await publisher.announce(TvState("on", 10, None, "hot"))
    assert transport.sent[0]["body"] == {
        "power": "on",
        "volume": 10,
        "app": None,
        "connection": "hot",
    }


async def test_the_reason_goes_with_missing_only() -> None:
    tracker = AdbPermissionTracker()
    publisher, transport = make_publisher(tracker, supported=True)
    tracker.report("missing", "tv_forgot")
    await publisher.announce(TvState("on", 10, None, "hot"))
    tracker.report("granted", "accepted")
    await publisher.announce(TvState("on", 10, None, "hot"))
    tracker.report("pending", "prompt_on_tv")
    await publisher.announce(TvState("on", 10, None, "hot"))
    first, second, third = (m["body"] for m in transport.sent)
    assert (first["adbPermission"], first["adbPermissionReason"]) == ("missing", "tv_forgot")
    assert second["adbPermission"] == "granted" and "adbPermissionReason" not in second
    assert third["adbPermission"] == "pending" and "adbPermissionReason" not in third
