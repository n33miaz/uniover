import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import (
    Backoff,
    BackoffPolicy,
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
)
from uniover_agent.core.connection import (
    APPLICATION_KEEPALIVE_SECONDS,
    DUPLICATE_WINDOW_SECONDS,
    NETWORK_WAKE_MIN_SECONDS,
    RECANDIDACY_LIMIT,
    STOP_CREDENTIAL_REJECTED,
    STOP_DUPLICATE,
    STOP_HANDOVER,
)
from uniover_agent.ports import (
    ConnectionReplaced,
    CredentialRejected,
    HandoverRequested,
    ServerRestarting,
    ServerRestartNow,
    TransportError,
)

from .support import AGENT_ID

POLICY = BackoffPolicy()


def middle() -> float:
    return 0.5  # fator 1,0: sem jitter


def test_backoff_doubles_then_caps_at_thirty() -> None:
    backoff = Backoff(POLICY, middle)
    assert [backoff.next_delay() for _ in range(8)] == [1, 2, 4, 8, 16, 30, 30, 30]


def test_backoff_jitter_stays_within_bounds_and_cap() -> None:
    low = Backoff(POLICY, lambda: 0.0)
    high = Backoff(POLICY, lambda: 1.0)
    assert low.next_delay() == pytest.approx(0.8)
    assert high.next_delay() == pytest.approx(1.2)
    for _ in range(10):
        low.next_delay()
        assert high.next_delay() <= POLICY.cap


def test_backoff_reset_returns_to_start() -> None:
    backoff = Backoff(POLICY, middle)
    for _ in range(4):
        backoff.next_delay()
    backoff.reset()
    assert backoff.next_delay() == 1


class WaitingClock(FakeClock):
    """`sleep` espera o teste soltar; o relógio monotônico só anda quando o teste manda."""

    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        await self.release.wait()


class FakeWatcher:
    def __init__(self, on_change: Callable[[], None]) -> None:
        self._on_change = on_change
        self.starts = 0
        self.stops = 0

    def start(self) -> None:
        self.starts += 1

    def stop(self) -> None:
        self.stops += 1

    def notify(self) -> None:
        self._on_change()


def network_supervisor(
    clock: FakeClock, transport: FakeTransport
) -> tuple[ConnectionSupervisor, dict[str, FakeWatcher]]:
    holder: dict[str, FakeWatcher] = {}

    def watcher_factory(on_change: Callable[[], None]) -> FakeWatcher:
        holder["watcher"] = FakeWatcher(on_change)
        return holder["watcher"]

    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        network_watcher=watcher_factory,
    )
    return supervisor, holder


async def settle(condition: Callable[[], bool]) -> bool:
    for _ in range(200):
        if condition():
            return True
        await asyncio.sleep(0)
    return condition()


async def test_network_change_wakes_common_reconnect_backoff_and_stops_the_observer(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = WaitingClock()
    transport = FakeTransport()
    transport.connect_error = TransportError("sem rede")
    supervisor, holder = network_supervisor(clock, transport)

    with caplog.at_level(logging.INFO):
        task = asyncio.create_task(supervisor.run())
        assert await settle(lambda: len(clock.sleeps) == 1)
        # O aviso chega de outra thread, como no Windows.
        await asyncio.to_thread(holder["watcher"].notify)
        assert await settle(lambda: transport.connects >= 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert holder["watcher"].starts == 1
    assert holder["watcher"].stops == 1
    assert [record.message for record in caplog.records].count("a rede mudou") == 1


async def test_network_changes_wake_the_backoff_at_most_once_per_window() -> None:
    clock = WaitingClock()
    transport = FakeTransport()
    transport.connect_error = TransportError("sem rede")
    supervisor, holder = network_supervisor(clock, transport)

    task = asyncio.create_task(supervisor.run())
    assert await settle(lambda: len(clock.sleeps) == 1)
    holder["watcher"].notify()
    assert await settle(lambda: transport.connects == 2)
    assert await settle(lambda: len(clock.sleeps) == 2)

    # Oscilação logo depois do último despertar: o backoff não é anulado.
    for _ in range(5):
        holder["watcher"].notify()
        await asyncio.sleep(0)
    assert not await settle(lambda: transport.connects > 2)

    clock.advance(NETWORK_WAKE_MIN_SECONDS)
    holder["watcher"].notify()
    assert await settle(lambda: transport.connects == 3)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_network_change_before_the_wait_started_does_not_skip_the_backoff() -> None:
    clock = WaitingClock()
    transport = FakeTransport()
    supervisor, holder = network_supervisor(clock, transport)
    supervisor._start_network_watcher()

    # A conexão estava saudável quando a rede mudou: o aviso fica marcado até a próxima espera.
    holder["watcher"].notify()
    await asyncio.sleep(0)
    wait = asyncio.create_task(supervisor._sleep_for_reconnect(30))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert not wait.done()

    clock.release.set()
    await asyncio.wait_for(wait, timeout=2)
    supervisor._stop_network_watcher()


class Harness:
    def __init__(self, transport: FakeTransport, stop_after: int | None = None) -> None:
        self.clock = FakeClock()
        self.transport = transport
        self.processed: list[str | bytes] = []
        self.stop_after = stop_after
        gate = EnvelopeGate(AGENT_ID)
        self.supervisor = ConnectionSupervisor(
            transport,
            self._process,
            EnvelopeFactory(AGENT_ID, gate, self.clock),
            self.clock,
            middle,
            agent_version="0.1.0",
            capabilities=["tv.remote"],
        )

    async def _process(self, raw: str | bytes) -> None:
        self.processed.append(raw)

    async def run_until(self, done: Callable[[], bool]) -> None:
        """Roda o laço e o cancela quando `done()` for verdadeiro (o laço não termina sozinho)."""
        task = asyncio.create_task(self.supervisor.run())
        for _ in range(1000):
            if done() or task.done():
                break
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_connects_sends_hello_and_processes_messages() -> None:
    transport = FakeTransport([["a", "b"]])
    harness = Harness(transport)
    await harness.run_until(lambda: transport.connects >= 2)
    (hello, *_) = transport.sent
    assert hello["type"] == "agent.hello.v1"
    assert hello["body"] == {"agentVersion": "0.1.0", "capabilities": ["tv.remote"]}
    assert harness.processed == ["a", "b"]
    assert transport.closes >= 1


async def test_reconnects_with_growing_backoff_without_attempt_limit() -> None:
    transport = FakeTransport()
    transport.connect_error = TransportError("sem rede")
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 8)
    assert harness.clock.sleeps[:8] == [1, 2, 4, 8, 16, 30, 30, 30]


async def test_recent_connection_caps_reconnect_backoff_at_five_seconds() -> None:
    transport = FakeTransport([[TransportError("cai")]] * 8)
    harness = Harness(transport)

    await harness.run_until(lambda: len(harness.clock.sleeps) >= 8)

    assert harness.clock.sleeps[:8] == [1, 2, 4, 5, 5, 5, 5, 5]


async def test_connection_loss_log_includes_reason_and_session_duration(
    caplog: pytest.LogCaptureFixture,
) -> None:
    transport = FakeTransport([[TransportError("sem rede")]])
    harness = Harness(transport)

    with caplog.at_level(logging.INFO):
        await harness.run_until(lambda: len(harness.clock.sleeps) >= 1)

    assert "conexão perdida após 0.0 s: sem rede" in caplog.text


async def test_backoff_resets_after_stable_connection() -> None:
    clock_holder: dict[str, Harness] = {}

    class StableThenDrop(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            await super().send(message)
            # A terceira conexão dura 61 s antes de cair; as outras caem na hora.
            if self.connects == 3:
                clock_holder["h"].clock.advance(61)

    transport = StableThenDrop([[TransportError("cai")]] * 5)
    harness = Harness(transport)
    clock_holder["h"] = harness
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 4)
    # 1, 2 (duas quedas rápidas); a terceira conexão foi estável: volta a 1; depois 2.
    assert harness.clock.sleeps[:4] == [1, 2, 1, 2]


async def test_credential_rejected_stops_without_loop_and_without_sleep() -> None:
    transport = FakeTransport()
    transport.connect_error = CredentialRejected("401")
    harness = Harness(transport)
    await asyncio.wait_for(harness.supervisor.run(), timeout=2)
    assert transport.connects == 1
    assert harness.clock.sleeps == []
    assert transport.closes == 1


async def test_revocation_during_session_stops() -> None:
    transport = FakeTransport([["x", CredentialRejected("revogado")]])
    harness = Harness(transport)
    await asyncio.wait_for(harness.supervisor.run(), timeout=2)
    assert transport.connects == 1
    assert harness.processed == ["x"]


async def test_replaced_waits_longer_than_backoff_cap() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")]])
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 1)
    assert harness.clock.sleeps[0] == POLICY.replaced_wait
    assert POLICY.replaced_wait > POLICY.cap


async def test_cancellation_closes_the_transport() -> None:
    gate_open = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await gate_open.wait()
            yield "nunca"

    transport = Blocking()
    harness = Harness(transport)
    task = asyncio.create_task(harness.supervisor.run())
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert transport.closes == 1
    assert not transport.connected


async def test_on_connected_runs_after_the_hello_on_every_connection() -> None:
    clock = FakeClock()
    transport = FakeTransport([[TransportError("caiu")], []])
    order: list[str] = []

    async def announce() -> None:
        # Quando roda, o `hello` já saiu; o que vier depois dele é o estado atual.
        order.append(f"hello={len(transport.sent)}")

    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        on_connected=announce,
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if len(order) >= 2:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert order[:2] == ["hello=1", "hello=2"]


async def test_hello_now_resends_the_hello_with_the_current_capabilities() -> None:
    clock = FakeClock()
    capabilities = ["transport.keepalive.v1"]
    gate_open = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await gate_open.wait()
            yield "nunca"

    transport = Blocking()
    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=lambda: list(capabilities),
    )
    await supervisor.hello_now()  # sem sessão aberta: nada a reenviar
    assert transport.sent == []
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if transport.sent:
            break
        await asyncio.sleep(0)
    capabilities.append("tv.presence.v1")  # a API passou a listar a capacidade
    await supervisor.hello_now()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    declared = [m["body"]["capabilities"] for m in transport.sent if m["type"] == "agent.hello.v1"]
    assert declared == [["transport.keepalive.v1"], ["transport.keepalive.v1", "tv.presence.v1"]]
    await supervisor.hello_now()  # sessão encerrada: de novo nada a reenviar
    assert len(transport.sent) == 2


async def test_server_restart_reconnects_fast_without_growing_the_backoff() -> None:
    restarting: list[str | bytes | Exception] = [ServerRestarting("código 1012")]
    scripts: list[list[str | bytes | Exception]] = [
        restarting,
        restarting,
        restarting,
        [TransportError("cai")],
    ]
    transport = FakeTransport(scripts)
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 4)
    # Três avisos de reinício: espera curta e fixa; a primeira queda comum ainda começa em 1 s.
    assert harness.clock.sleeps[:4] == [POLICY.restart_wait] * 3 + [1]
    assert POLICY.restart_wait < 1


async def test_restart_now_notice_reconnects_fast_without_growing_the_backoff() -> None:
    notice: list[str | bytes | Exception] = [ServerRestartNow("4411")]
    transport = FakeTransport([notice, notice, [TransportError("cai")]])
    harness = Harness(transport)
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 3)
    # Sem jitter (sorteio do meio): 0,35 s; a primeira queda comum ainda começa em 1 s.
    assert harness.clock.sleeps[:3] == [pytest.approx(0.35)] * 2 + [1]


@pytest.mark.parametrize(("draw", "expected"), [(0.0, 0.2), (1.0, 0.5)])
async def test_restart_now_wait_stays_between_the_limits(draw: float, expected: float) -> None:
    transport = FakeTransport([[ServerRestartNow("4411")], [TransportError("cai")]])
    harness = Harness(transport)
    harness.supervisor._random = lambda: draw
    await harness.run_until(lambda: len(harness.clock.sleeps) >= 1)
    assert harness.clock.sleeps[0] == pytest.approx(expected)
    assert POLICY.restart_now_min <= harness.clock.sleeps[0] <= POLICY.restart_now_max


async def test_unexpected_exception_in_the_loop_does_not_kill_the_agent() -> None:
    transport = FakeTransport([[RuntimeError("bug")], ["ok"]])
    harness = Harness(transport)
    await harness.run_until(lambda: transport.connects >= 2 and harness.processed == ["ok"])
    assert harness.processed == ["ok"]
    assert harness.clock.sleeps[0] == 1


async def test_exception_from_message_processing_reconnects() -> None:
    transport = FakeTransport([["ruim"], ["bom"]])
    harness = Harness(transport)
    original = harness._process

    async def explode_once(raw: str | bytes) -> None:
        if raw == "ruim":
            raise ValueError("falha ao processar")
        await original(raw)

    harness.supervisor._process = explode_once
    await harness.run_until(lambda: harness.processed == ["bom"])
    assert harness.processed == ["bom"]


async def test_keepalive_send_failure_closes_the_channel_so_the_loop_reconnects() -> None:
    release = asyncio.Event()

    class BrokenKeepalive(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            if message["type"] == "agent.keepalive.v1":
                raise TransportError("canal quebrado")
            await super().send(message)

        async def incoming(self):  # type: ignore[no-untyped-def]
            # Fica aberto como uma conexão meio morta, até o laço fechá-la.
            await release.wait()
            raise TransportError("fechado")
            yield

        async def close(self) -> None:
            release.set()
            await super().close()

    transport = BrokenKeepalive()
    clock = FakeClock()
    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        keepalive_interval=0.01,
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(300):
        if transport.connects >= 2:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert transport.connects >= 2


async def test_the_keepalive_beats_every_five_seconds_and_carries_the_loop_lag_when_given() -> None:
    assert APPLICATION_KEEPALIVE_SECONDS == 5.0
    beats: list[dict[str, Any]] = []
    release = asyncio.Event()

    class Recording(FakeTransport):
        async def send(self, message: dict[str, Any]) -> None:
            if message["type"] == "agent.keepalive.v1":
                beats.append(message["body"])
            await super().send(message)

        async def incoming(self):  # type: ignore[no-untyped-def]
            await release.wait()
            raise TransportError("fechado")
            yield

    # Sem o campo aceito pela API, `None`: o batimento sai vazio, como o de sempre.
    lags = iter([None, 12, 0])
    clock = FakeClock()
    supervisor = ConnectionSupervisor(
        Recording(),
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        keepalive_interval=0.01,
        keepalive_lag_ms=lambda: next(lags, 0),
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(300):
        if len(beats) >= 3:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert beats[:3] == [{}, {"loopLagMs": 12}, {"loopLagMs": 0}]


# ---- passagem para uma versão nova (handover) e disputa de identidade ----


def _supervisor(  # noqa: PLR0913 - as variações que cada teste muda, todas por nome
    transport: FakeTransport,
    clock: FakeClock,
    *,
    handover: bool = False,
    on_accepted: Callable[[], None] | None = None,
    is_owner: Callable[[], bool] | None = None,
    policy: BackoffPolicy | None = None,
    rehello_interval: float = 300.0,
    keepalive_interval: float = 25.0,
) -> ConnectionSupervisor:
    return ConnectionSupervisor(
        transport,
        lambda raw: asyncio.sleep(0),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=["tv.remote"],
        policy=policy,
        handover=handover,
        on_handover_accepted=on_accepted,
        is_owner=is_owner,
        rehello_interval=rehello_interval,
        keepalive_interval=keepalive_interval,
    )


async def test_handover_requested_stops_without_reconnecting() -> None:
    transport = FakeTransport([["a", HandoverRequested("uma versão nova assumiu")]])
    clock = FakeClock()
    supervisor = _supervisor(transport, clock)
    await asyncio.wait_for(supervisor.run(), timeout=2)
    # Reconectar tiraria a versão nova do lugar: sem espera, sem segunda conexão.
    assert transport.connects == 1
    assert clock.sleeps == []
    assert supervisor.stop_reason == STOP_HANDOVER


async def test_the_stop_reason_tells_a_rejected_credential_apart() -> None:
    transport = FakeTransport()
    transport.connect_error = CredentialRejected("401")
    supervisor = _supervisor(transport, FakeClock())
    assert supervisor.stop_reason is None
    await asyncio.wait_for(supervisor.run(), timeout=2)
    assert supervisor.stop_reason == STOP_CREDENTIAL_REJECTED


async def test_a_second_replacement_in_ten_minutes_stops_as_a_duplicate() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")], [ConnectionReplaced("outra")]])
    clock = FakeClock()
    supervisor = _supervisor(transport, clock)
    await asyncio.wait_for(supervisor.run(), timeout=2)
    # A primeira substituição espera os 60 s de sempre; a segunda, em menos de 10 min, é disputa.
    assert clock.sleeps == [POLICY.replaced_wait]
    assert transport.connects == 2
    assert supervisor.stop_reason == STOP_DUPLICATE


async def test_replacements_far_apart_are_not_a_duplicate() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")] for _ in range(3)])
    clock = FakeClock()
    # Cada espera passa da janela de 10 minutos: as substituições não se acumulam.
    supervisor = _supervisor(
        transport, clock, policy=BackoffPolicy(replaced_wait=DUPLICATE_WINDOW_SECONDS + 1)
    )
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if transport.connects >= 3:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert transport.connects >= 3
    assert supervisor.stop_reason is None


def _ack(instance_id: str | None, *, source: str = "api") -> str:
    """A confirmação que a API manda à candidata promovida (`agent.handover.accepted.v1`)."""
    return json.dumps(
        {
            "v": 1,
            "id": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ec1",
            "type": "agent.handover.accepted.v1",
            "source": source,
            "target": "agent:pc-casa",
            "ts": "2026-11-10T14:00:00Z",
            "correlationId": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ec0",
            "body": {"instanceId": instance_id},
        }
    )


async def _run_until(supervisor: ConnectionSupervisor, done: Callable[[], bool]) -> None:
    task = asyncio.create_task(supervisor.run())
    for _ in range(400):
        if done():
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_the_handover_stays_pending_after_the_hello_is_sent_until_the_api_confirms() -> None:
    # O envio local do hello não prova que a API o leu: sem a confirmação segue candidata.
    release = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await release.wait()
            yield "nunca"

    transport = Blocking()
    supervisor = _supervisor(transport, FakeClock(), handover=True)
    assert supervisor.handover_pending is True
    await _run_until(supervisor, lambda: bool(transport.sent))
    assert supervisor.handover_pending is True
    assert _supervisor(FakeTransport(), FakeClock()).handover_pending is False


async def test_a_drop_before_the_confirmation_keeps_the_next_connection_a_candidate() -> None:
    candidate_flags: list[bool] = []

    class Recording(FakeTransport):
        async def connect(self) -> None:
            candidate_flags.append(supervisor.handover_pending)
            await super().connect()

    # 1ª conexão: o hello sai e a conexão cai antes de a API ler. 2ª: a API confirma.
    transport = Recording([[TransportError("caiu antes da admissão")], [], []])
    accepted: list[bool] = []
    supervisor = _supervisor(
        transport, FakeClock(), handover=True, on_accepted=lambda: accepted.append(True)
    )
    await _run_until(supervisor, lambda: transport.connects >= 2)
    # As duas conexões se apresentam como candidatas e os dois hellos pedem a passagem.
    assert candidate_flags[:2] == [True, True]
    hellos = [m["body"] for m in transport.sent if m["type"] == "agent.hello.v1"]
    assert [h.get("handover") for h in hellos[:2]] == [True, True]
    assert hellos[0]["instanceId"] == hellos[1]["instanceId"]
    assert supervisor.handover_pending is True
    assert accepted == []


async def test_the_confirmation_with_its_instance_id_ends_the_candidacy_and_is_not_forwarded() -> (
    None
):
    forwarded: list[str | bytes] = []
    accepted: list[bool] = []
    transport = FakeTransport()
    clock = FakeClock()
    supervisor = ConnectionSupervisor(
        transport,
        lambda raw: _collect(forwarded, raw),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        clock,
        middle,
        agent_version="0.1.0",
        capabilities=[],
        handover=True,
        on_handover_accepted=lambda: accepted.append(True),
    )
    assert supervisor.instance_id is not None
    transport.sessions = [[_ack(supervisor.instance_id), "comando"]]
    await _run_until(supervisor, lambda: "comando" in forwarded)
    assert accepted == [True]
    assert supervisor.handover_pending is False
    # A confirmação é do canal: o resto do agente só vê o comando.
    assert forwarded == ["comando"]


async def _collect(into: list[str | bytes], raw: str | bytes) -> None:
    into.append(raw)


@pytest.mark.parametrize("variant", ["another-instance", "not-from-the-api", "no-instance"])
async def test_a_confirmation_that_is_not_for_this_run_is_dropped_and_changes_nothing(
    variant: str,
) -> None:
    accepted: list[bool] = []
    transport = FakeTransport()
    supervisor = _supervisor(
        transport, FakeClock(), handover=True, on_accepted=lambda: accepted.append(True)
    )
    assert supervisor.instance_id is not None
    wrong = {
        "another-instance": _ack("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8eff"),
        "not-from-the-api": _ack(supervisor.instance_id, source="agent:pc-casa"),
        "no-instance": _ack(None),
    }[variant]
    transport.sessions = [[wrong]]
    await _run_until(
        supervisor, lambda: transport.connects >= 1 and transport.closes >= 0 and False
    )
    assert accepted == []
    assert supervisor.handover_pending is True


async def test_the_hello_keeps_saying_handover_until_the_confirmation() -> None:
    release = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await release.wait()
            yield "nunca"

    transport = Blocking()
    supervisor = _supervisor(transport, FakeClock(), handover=True)
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if transport.sent:
            break
        await asyncio.sleep(0)
    await supervisor.hello_now()  # o reenvio (do periódico ou de uma capacidade nova)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    hellos = [m["body"] for m in transport.sent if m["type"] == "agent.hello.v1"]
    assert len(hellos) == 2
    assert [h["handover"] for h in hellos] == [True, True]
    # O identificador é desta execução e não muda entre os hellos.
    assert hellos[0]["instanceId"] == hellos[1]["instanceId"]


async def test_after_the_confirmation_the_hello_says_neither_handover_nor_instance_id() -> None:
    transport = FakeTransport()
    supervisor = _supervisor(transport, FakeClock(), handover=True)
    assert supervisor.instance_id is not None
    transport.sessions = [[_ack(supervisor.instance_id)]]
    await _run_until(supervisor, lambda: supervisor.handover_pending is False)
    assert supervisor.handover_pending is False
    body = supervisor._hello()["body"]
    # Uma API revertida (contrato fechado) recusaria os dois campos num hello comum.
    assert "handover" not in body
    assert "instanceId" not in body


async def test_a_plain_hello_carries_neither_handover_nor_instance_id() -> None:
    transport = FakeTransport([["a"]])
    supervisor = _supervisor(transport, FakeClock())
    task = asyncio.create_task(supervisor.run())
    for _ in range(200):
        if transport.sent:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    body = transport.sent[0]["body"]
    assert "handover" not in body
    assert "instanceId" not in body


# ---- 4409 antes de virar dona: a candidata volta já ----


async def test_a_candidate_replaced_before_it_owns_the_installation_comes_back_at_once() -> None:
    candidate_flags: list[bool] = []

    class Recording(FakeTransport):
        async def connect(self) -> None:
            candidate_flags.append(supervisor.handover_pending)
            await super().connect()

    transport = Recording()
    clock = FakeClock()
    supervisor = _supervisor(transport, clock, handover=True, is_owner=lambda: False)
    assert supervisor.instance_id is not None
    # A API a promoveu (confirmação) e, logo depois, um deploy a tirou do lugar com 4409.
    transport.sessions = [[_ack(supervisor.instance_id), ConnectionReplaced("outra")], []]
    await _run_until(supervisor, lambda: transport.connects >= 2)
    assert transport.connects >= 2
    # A 2ª conexão é de candidata de novo, com o mesmo `instanceId`, e sem os 60 s do `replaced`.
    assert candidate_flags[:2] == [True, True]
    hellos = [m["body"] for m in transport.sent if m["type"] == "agent.hello.v1"]
    assert [h.get("handover") for h in hellos[:2]] == [True, True]
    assert hellos[0]["instanceId"] == hellos[1]["instanceId"] == supervisor.instance_id
    assert POLICY.replaced_wait not in clock.sleeps
    assert clock.sleeps[0] <= POLICY.restart_now_max
    assert supervisor.stop_reason is None


async def test_a_run_that_already_owns_the_installation_keeps_the_replaced_wait() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")], []])
    clock = FakeClock()
    supervisor = _supervisor(transport, clock, handover=True, is_owner=lambda: True)
    await _run_until(supervisor, lambda: len(clock.sleeps) >= 1)
    assert clock.sleeps[0] == POLICY.replaced_wait
    assert supervisor.handover_pending is True  # sem confirmação, segue candidata como antes


async def test_a_plain_run_never_becomes_a_candidate_when_replaced() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")], []])
    clock = FakeClock()
    supervisor = _supervisor(transport, clock, is_owner=lambda: False)
    await _run_until(supervisor, lambda: len(clock.sleeps) >= 1)
    assert clock.sleeps[0] == POLICY.replaced_wait
    assert supervisor.handover_pending is False


async def test_a_candidate_that_keeps_being_replaced_falls_back_to_the_usual_wait() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")] for _ in range(8)])
    clock = FakeClock()
    supervisor = _supervisor(transport, clock, handover=True, is_owner=lambda: False)
    await _run_until(supervisor, lambda: len(clock.sleeps) >= RECANDIDACY_LIMIT + 1)
    # As primeiras voltam já; passado o limite, a disputa vale a espera de sempre.
    assert all(wait <= POLICY.restart_now_max for wait in clock.sleeps[:RECANDIDACY_LIMIT])
    assert clock.sleeps[RECANDIDACY_LIMIT] == POLICY.replaced_wait


# ---- pedido de parada vindo de fora (a saída ordenada da execução antiga) ----


async def test_a_stop_request_ends_an_open_session_and_closes_the_channel() -> None:
    release = asyncio.Event()

    class Blocking(FakeTransport):
        async def incoming(self):  # type: ignore[no-untyped-def]
            await release.wait()
            yield "nunca"

    transport = Blocking()
    supervisor = _supervisor(transport, FakeClock())
    task = asyncio.create_task(supervisor.run())
    assert await settle(lambda: transport.connected)
    supervisor.request_stop(STOP_HANDOVER)
    await asyncio.wait_for(task, timeout=2)
    assert supervisor.stop_reason == STOP_HANDOVER
    assert transport.connects == 1
    assert transport.closes == 1


async def test_a_stop_request_ends_the_wait_after_a_replacement_without_reconnecting() -> None:
    transport = FakeTransport([[ConnectionReplaced("outra")]])
    clock = WaitingClock()
    supervisor = _supervisor(transport, clock)
    task = asyncio.create_task(supervisor.run())
    # Dentro dos 60 s do `replaced`: é aí que o pedido tem de valer.
    assert await settle(lambda: clock.sleeps == [POLICY.replaced_wait])
    supervisor.request_stop(STOP_HANDOVER)
    await asyncio.wait_for(task, timeout=2)
    assert supervisor.stop_reason == STOP_HANDOVER
    assert transport.connects == 1


async def test_a_stop_asked_before_the_run_starts_is_not_lost() -> None:
    transport = FakeTransport()
    supervisor = _supervisor(transport, FakeClock())
    supervisor.request_stop(STOP_HANDOVER)
    await asyncio.wait_for(supervisor.run(), timeout=2)
    assert supervisor.stop_reason == STOP_HANDOVER


async def test_cancelling_the_run_still_cancels_it() -> None:
    transport = FakeTransport()
    supervisor = _supervisor(transport, WaitingClock())
    task = asyncio.create_task(supervisor.run())
    assert await settle(lambda: transport.connects >= 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert supervisor.stop_reason is None
