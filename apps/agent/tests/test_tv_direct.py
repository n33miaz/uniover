"""A TV pelo canal direto: escopos, o mesmo caminho da nuvem e a ponte entre os laços."""

import asyncio
import logging
import threading
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.pc_input_thread import MainLoopCaller, PcInputThread
from uniover_agent.composition.connection import declarable_capabilities
from uniover_agent.composition.pc import build_pc
from uniover_agent.config import Settings
from uniover_agent.core import (
    TV_RTC_CAPABILITY,
    ClockOffset,
    Command,
    DirectSettings,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    PcDirectService,
    PcUseTracker,
    ProcessMessage,
    TvCounts,
    TvDirectBridge,
    pc_handlers,
    pc_rtc_handlers,
)
from uniover_agent.core.domain import CommandResult, ResultStatus
from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.core.pc.direct import REFUSED_UNAVAILABLE, DirectRefused
from uniover_agent.core.tv.handlers import ValidatedCommand, tv_key_handler, tv_text_handler
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import INPUT_CHANNEL, POINTER_CHANNEL, PeerCallbacks

from .support import AGENT_ID, FakeAudio, dump, envelope
from .test_pc_composition import FakeLauncher, FakePower
from .test_pc_direct import (
    SDP,
    SESSION,
    TOKEN,
    FakeInput,
    FakePeer,
    _Approvals,
    settle,
    settle_close,
)


class FakeTv:
    """A TV de mentira: o que a sessão receberia, e um portão para segurar a tecla no meio."""

    def __init__(self) -> None:
        self.keys: list[tuple[str, str]] = []
        self.texts: list[str] = []
        self.gate: asyncio.Event | None = None
        self.text_gate: asyncio.Event | None = None
        self.refuse_with: TvSessionError | None = None
        self.threads: set[str] = set()

    async def send_key(
        self, key: str, direction: str = "SHORT", *, validate: Callable[[], None] | None = None
    ) -> None:
        self.threads.add(threading.current_thread().name)
        if self.gate is not None:
            await self.gate.wait()
        if validate is not None:
            validate()
        if self.refuse_with is not None:
            raise self.refuse_with
        self.keys.append((key, direction))

    async def send_text(self, text: str) -> None:
        self.texts.append(text)

    async def launch_link(self, link: str) -> None: ...

    async def wake(self) -> None: ...

    async def power_off(self) -> Any: ...


class FakeReconciler:
    def __init__(self, tv: FakeTv) -> None:
        self._tv = tv

    async def set_text(
        self, text: str, *, queued: float = 0.0, validate: Callable[[], None] | None = None
    ) -> None:
        # Como o editor de verdade: a validade vale antes de cada efeito, depois de qualquer espera.
        if self._tv.text_gate is not None:
            await self._tv.text_gate.wait()
        if validate is not None:
            validate()
        self._tv.texts.append(text)


def tv_handlers(tv: FakeTv, clock: FakeClock) -> dict[str, Any]:
    keys = tv_key_handler(tv, monotonic=time.monotonic)
    return {
        "tv.key.v1": keys,
        "tv.key.v2": keys,
        "tv.key.v3": keys,
        "tv.text.v1": tv_text_handler(tv, reconciler=FakeReconciler(tv)),  # type: ignore[arg-type]
    }


class TvLab:
    """O serviço do canal, a faixa do PC e o caminho das teclas da TV de verdade, no mesmo laço."""

    def __init__(self, *, with_tv: bool = True, command_timeout: float | None = None) -> None:
        self.clock = FakeClock()
        self.gate = EnvelopeGate(AGENT_ID)
        self.transport = FakeTransport()
        self.envelopes = EnvelopeFactory(AGENT_ID, self.gate, self.clock)
        self.tv = FakeTv()
        self.pc = FakeInput()
        self.api_clock = ClockOffset()
        self.closed: list[tuple[str, str, TvCounts | None]] = []
        self.peers: list[FakePeer] = []
        self.lost = 0
        self.seen: list[str] = []
        handlers: dict[str, Any] = pc_handlers(
            self.pc,
            FakePower(),
            FakeLauncher(),
            [],
            shutdown_delay_seconds=30,
            clock=self.api_clock,
            use=PcUseTracker(),
            audio=FakeAudio(),
        )
        handlers.update(tv_handlers(self.tv, self.clock))

        async def notify(session_id: str, reason: str, tv: TvCounts | None = None) -> None:
            self.closed.append((session_id, reason, tv))

        self.service = PcDirectService(
            factory=self._factory,
            agent_id=AGENT_ID,
            gate=self.gate,
            api_clock=self.api_clock,
            notify_closed=notify,
            settings=DirectSettings(tick_seconds=0.005),
        )
        handlers.update(pc_rtc_handlers(self.service, self.transport, self.envelopes))
        self.process = ProcessMessage(
            AGENT_ID,
            self.gate,
            HandleCommand(handlers, self.clock),
            self.envelopes,
            self.transport,
            command_timeout_seconds=command_timeout,
            on_command=lambda command: self.seen.append(command.type),
            on_cloud_pc_input=self.service.cloud_input,
            release_inputs=self.pc.release_all,
            direct_active=lambda: self.service.holds_inputs,
        )

        def lost() -> None:
            self.lost += 1
            self.process.direct_lost()

        self.service.bind(self.process.submit_direct, lost)
        if with_tv:
            # Num laço só: a ponte entrega e devolve na hora, como o laço principal único.
            bridge = TvDirectBridge(
                self.process.submit_direct_tv,
                to_main=lambda callback, *args: callback(*args),
                to_lane=lambda callback: callback(),
            )
            self.service.bind_tv(bridge.submit)

    def _factory(self, callbacks: PeerCallbacks) -> FakePeer:
        peer = FakePeer(callbacks)
        self.peers.append(peer)
        return peer

    @property
    def peer(self) -> FakePeer:
        return self.peers[-1]

    async def open(self, scopes: list[str] | None = None, session: str = SESSION) -> FakePeer:
        await self.service.open(session, SDP, TOKEN, 30, None, scopes=scopes)
        self.peer.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
        await settle()
        for n in (1, 2):
            self.peer.phone(POINTER_CHANNEL, {"k": "ping", "n": n, "t": int(time.time() * 1000)})
        await settle()
        return self.peer

    @staticmethod
    def command(
        message_type: str, body: dict[str, Any], command_id: str = "c1", age_ms: int = 0
    ) -> dict[str, Any]:
        return {
            "k": "cmd",
            "i": command_id,
            "t": message_type,
            "b": body,
            "ts": int(time.time() * 1000) - age_ms,
            "p": {"s": 0, "x": 0, "y": 0, "w": 0, "h": 0},
        }

    async def aclose(self) -> None:
        await self.service.aclose()
        await self.process.aclose()


@pytest.fixture
async def lab() -> AsyncIterator[TvLab]:
    instance = TvLab()
    yield instance
    await instance.aclose()


def ack(peer: FakePeer, command_id: str) -> dict[str, Any]:
    found = [m for m in peer.acks() if m["i"] == command_id]
    assert found, f"sem ack de {command_id}: {peer.acks()}"
    return found[-1]


# ---- o escopo `tv`: abrir, `ready` e as teclas no mesmo caminho da nuvem ------------------------


async def test_a_tv_channel_says_its_scopes_and_lists_only_the_tv_messages(lab: TvLab) -> None:
    peer = await lab.open(["tv"])

    ready = next(m for c, m in peer.sent if c == INPUT_CHANNEL and m["k"] == "ready")
    assert ready["sc"] == ["tv"]
    assert ready["caps"] == ["tv.key.v2", "tv.key.v3", "tv.text.v1"]


async def test_a_pc_channel_without_scopes_is_as_before_and_does_not_list_tv(lab: TvLab) -> None:
    peer = await lab.open(None)

    ready = next(m for c, m in peer.sent if c == INPUT_CHANNEL and m["k"] == "ready")
    assert ready["sc"] == ["pc"]
    assert not {"tv.key.v2", "tv.key.v3", "tv.text.v1"} & set(ready["caps"])


async def test_a_direct_key_runs_the_same_handler_as_the_cloud_and_is_answered_on_the_channel(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "RIGHT"}, "k1"))
    await settle()

    assert lab.tv.keys == [("RIGHT", "SHORT")]
    assert ack(peer, "k1")["ok"] is True
    assert lab.transport.sent == []  # nenhuma resposta pela nuvem: o resultado volta pelo canal
    assert lab.seen == [
        "tv.key.v2"
    ]  # `on_command` (o agendador de limpeza) também vê a tecla direta


async def test_direct_and_cloud_keys_share_one_ordered_chain(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "RIGHT"}, "k1"))
    await settle()
    # Uma tecla da nuvem chega enquanto a direta espera a TV: entra atrás dela, na mesma fila.
    await lab.process(dump(envelope("tv.key.v2", {"key": "OK"})))
    await settle()
    assert lab.tv.keys == []
    lab.tv.gate.set()
    await settle()

    assert lab.tv.keys == [("RIGHT", "SHORT"), ("OK", "SHORT")]
    assert lab.process._tv_path == "nuvem"


async def test_a_key_older_than_the_limit_is_discarded_by_the_same_rule_as_the_cloud(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "RIGHT"}, "k1"))
    await asyncio.sleep(1.6)  # a TV demorou: o mesmo descarte por idade da nuvem (1,5 s)
    lab.tv.gate.set()
    await settle()

    assert lab.tv.keys == []
    reply = ack(peer, "k1")
    assert (reply["ok"], reply["c"]) == (False, "agent_timeout")


async def test_a_key_that_is_stale_on_the_wire_is_refused_without_touching_the_tv(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k1", age_ms=2_500))
    await settle()

    assert lab.tv.keys == []
    assert ack(peer, "k1") == {"k": "ack", "i": "k1", "ok": False, "c": "expired"}


async def test_the_tv_refusing_the_key_is_told_to_the_app_with_the_code(lab: TvLab) -> None:
    lab.tv.refuse_with = TvSessionError("tv_unreachable", "sem sessão")
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k1"))
    await settle()

    assert ack(peer, "k1")["c"] == "tv_unreachable"


async def test_text_goes_through_the_text_handler_after_the_earlier_keys(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "OK"}, "k1"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.text.v1", {"text": "filme"}, "t1"))
    await settle()
    assert lab.tv.texts == []  # o texto espera a tecla que veio antes
    lab.tv.gate.set()
    await settle()

    assert lab.tv.keys == [("OK", "SHORT")]
    assert lab.tv.texts == ["filme"]
    assert ack(peer, "t1")["ok"] is True


async def test_the_command_timeout_answers_on_the_channel(lab: TvLab) -> None:
    capped = TvLab(command_timeout=0.05)
    try:
        peer = await capped.open(["tv"])
        capped.tv.gate = asyncio.Event()
        peer.phone(INPUT_CHANNEL, capped.command("tv.key.v2", {"key": "OK"}, "k1"))
        await asyncio.sleep(0.2)

        reply = ack(peer, "k1")
        assert (reply["ok"], reply["c"]) == (False, "tv_unreachable")
        assert capped.transport.sent == []
    finally:
        capped.tv.gate = None
        await capped.aclose()


# ---- o que o canal da TV NÃO faz ---------------------------------------------------------------


@pytest.mark.parametrize("message_type", ["tv.key.v2", "tv.key.v3"])
async def test_power_is_refused_on_the_channel(lab: TvLab, message_type: str) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command(message_type, {"key": "POWER"}, "k1"))
    await settle()

    assert lab.tv.keys == []
    assert ack(peer, "k1") == {"k": "ack", "i": "k1", "ok": False, "c": "not_allowed"}


@pytest.mark.parametrize(
    "message_type",
    ["tv.power.off.v1", "tv.app.launch.v1", "tv.cleanup.v1", "tv.wake.v1", "tv.key.v1"],
)
async def test_the_other_tv_actions_never_travel_the_channel(lab: TvLab, message_type: str) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command(message_type, {"key": "OK"}, "k1"))
    await settle()

    assert lab.tv.keys == []
    assert ack(peer, "k1")["c"] == "not_allowed"


async def test_a_tv_only_channel_refuses_the_pc_and_the_pointer(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("pc.key.v2", {"key": "A"}, "p1"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "p2"))
    peer.phone(POINTER_CHANNEL, {"k": "ptr", "s": 1, "x": 50, "y": 0, "w": 0, "h": 0})
    await settle()

    assert lab.pc.calls == []
    assert ack(peer, "p1")["c"] == "not_allowed"
    assert ack(peer, "p2")["c"] == "not_allowed"
    # O sinal de vida segue valendo (é ele que dá o RTT e a escala de relógio).
    pongs = [m for c, m in peer.sent if c == POINTER_CHANNEL and m.get("k") == "pong"]
    assert len(pongs) == 2


async def test_a_pc_only_channel_refuses_the_tv(lab: TvLab) -> None:
    peer = await lab.open(["pc"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k1"))
    await settle()

    assert lab.tv.keys == []
    assert ack(peer, "k1")["c"] == "not_allowed"


async def test_a_tv_channel_without_a_bridge_is_refused_at_the_offer() -> None:
    bare = TvLab(with_tv=False)
    try:
        with pytest.raises(DirectRefused) as refused:
            await bare.service.open(SESSION, SDP, TOKEN, 30, None, scopes=["tv"])
        assert refused.value.code == REFUSED_UNAVAILABLE
        assert bare.service.session_id is None
        assert not bare.service.carries_tv
    finally:
        await bare.aclose()


@pytest.mark.parametrize("scopes", [[], ["power"], ["pc", "admin"]])
async def test_unknown_or_empty_scopes_are_refused(lab: TvLab, scopes: list[str]) -> None:
    with pytest.raises(DirectRefused):
        await lab.service.open(SESSION, SDP, TOKEN, 30, None, scopes=scopes)


async def test_a_tv_only_offer_never_asks_the_owner_to_approve_the_phone(lab: TvLab) -> None:
    approvals = _Approvals(DeviceDecision.PENDING)
    lab.service._devices = approvals  # type: ignore[assignment]

    await lab.service.open(
        SESSION, SDP, TOKEN, 30, None, device_id="3fa9c10d7be2465a", scopes=["tv"]
    )

    assert approvals.checked == []
    assert lab.service.session_id == SESSION
    await lab.service.close(SESSION)
    with pytest.raises(DirectRefused):  # o escopo do PC continua exigindo a aprovação
        await lab.service.open(
            "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e02", SDP, TOKEN, 30, None, scopes=["pc", "tv"]
        )
    assert approvals.checked


async def test_closing_a_tv_only_channel_never_releases_what_the_pc_holds(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "OK"}, "k1"))
    await settle()

    await lab.service.close(SESSION)
    await settle_close()

    assert lab.lost == 0
    assert ("release_all",) not in lab.pc.calls


async def test_closing_a_pc_channel_still_releases(lab: TvLab) -> None:
    await lab.open(["pc"])
    await lab.service.close(SESSION)
    await settle_close()

    assert lab.lost == 1


async def test_cloud_pc_input_does_not_close_a_tv_only_channel(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "OK"}, "k1"))
    await settle()

    lab.service.cloud_input("pc.key.v2", 5, None)
    await settle_close()

    assert lab.service.session_id == SESSION
    assert not lab.service.holds_inputs


async def test_a_both_scopes_channel_works_for_the_pc_and_the_tv(lab: TvLab) -> None:
    peer = await lab.open(["pc", "tv"])
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "p1"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "OK"}, "k1"))
    await settle()

    assert ("media", "MUTE", 1) in lab.pc.calls
    assert lab.tv.keys == [("OK", "SHORT")]
    assert lab.service.holds_inputs


# ---- tetos, registro e a soma do fechamento ------------------------------------------------------


async def test_the_tv_rate_limit_refuses_the_excess_without_a_violation() -> None:
    limited = TvLab()
    limited.service._settings = DirectSettings(tick_seconds=0.005, max_tv_per_second=3)
    try:
        peer = await limited.open(["tv"])
        for n in range(5):
            peer.phone(INPUT_CHANNEL, limited.command("tv.key.v2", {"key": "UP"}, f"k{n}"))
        await settle()

        assert len(limited.tv.keys) == 3
        assert ack(peer, "k4")["c"] == "rate_limited"
    finally:
        await limited.aclose()


async def test_closing_reports_the_tv_sum_and_never_the_content(
    lab: TvLab, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    peer = await lab.open(["tv"])
    for n in range(2):
        peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "DOWN"}, f"k{n}"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.text.v1", {"text": "segredo-da-senha"}, "t1"))
    await settle()

    await lab.service._finish(lab.service._current, "idle")  # type: ignore[arg-type]
    await settle_close()

    assert lab.closed == [(SESSION, "idle", TvCounts(keys=2, texts=1))]
    assert "segredo" not in caplog.text
    assert "escopos tv" in caplog.text and "TV pelo canal: 2 teclas, 1 textos" in caplog.text


async def test_a_close_asked_by_the_api_does_not_answer_back(lab: TvLab) -> None:
    await lab.open(["tv"])

    await lab.service.close(SESSION, "rescoped")
    await settle_close()

    assert lab.closed == []
    assert lab.service.session_id is None


async def test_a_pc_only_close_sends_no_tv_sum() -> None:
    plain = TvLab()
    try:
        await plain.open(["pc"])
        await plain.service._finish(plain.service._current, "idle")  # type: ignore[arg-type]
        await settle_close()

        assert plain.closed == [(SESSION, "idle", None)]
    finally:
        await plain.aclose()


async def test_the_offer_handler_passes_the_scopes_of_the_envelope(lab: TvLab) -> None:
    handlers = pc_rtc_handlers(lab.service, lab.transport, lab.envelopes)
    command = Command(
        "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e77",
        "pc.rtc.offer.v1",
        {
            "sessionId": SESSION,
            "sdp": SDP,
            "token": TOKEN,
            "tokenTtlSeconds": 30,
            "maxLifetimeSeconds": 600,
            "scopes": ["tv"],
        },
    )

    result = await handlers["pc.rtc.offer.v1"](command)

    assert result.status is ResultStatus.OK
    peer = lab.peer
    peer.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
    await settle()
    ready = next(m for c, m in peer.sent if c == INPUT_CHANNEL and m["k"] == "ready")
    assert ready["sc"] == ["tv"]


# ---- a ponte entre os dois laços ----------------------------------------------------------------


class ThreadRig:
    """O agente como em produção: o laço do teste é o principal; a entrada do PC tem a thread."""

    def __init__(self) -> None:
        self.tv = FakeTv()
        self.transport = FakeTransport()
        self.gate = EnvelopeGate(AGENT_ID)
        self.clock = FakeClock()
        self.envelopes = EnvelopeFactory(AGENT_ID, self.gate, self.clock)
        self.peers: list[FakePeer] = []
        self.threads: list[str] = []
        pc = build_pc(
            Settings(pc_control=True, pc_direct=True),
            self.transport,
            self.envelopes,
            platform="win32",
            pc_input=FakeInput(),
            power=FakePower(),
            launcher=FakeLauncher(),
            audio=FakeAudio(),
            gate=self.gate,
            agent_id=AGENT_ID,
            isolate_input=True,
            prioritize=lambda: True,
            protect_memory=lambda minimum: True,
            direct_factory=self._factory,
            direct_available=lambda: True,
        )
        assert pc is not None
        self.pc = pc
        handlers = tv_handlers(self.tv, self.clock)
        self.process = ProcessMessage(
            AGENT_ID,
            self.gate,
            HandleCommand(handlers, self.clock),
            self.envelopes,
            self.transport,
            observe_timestamp=pc.clock.observe,
            pc_lane=pc.lane,
            pc_host=pc.host,
        )
        assert pc.bind_tv_direct(self.process.submit_direct_tv)

    def _factory(self, callbacks: PeerCallbacks) -> FakePeer:
        peer = FakePeer(callbacks)
        original = peer.send

        def send(channel: str, text: str) -> bool:
            self.threads.append(threading.current_thread().name)
            return original(channel, text)

        peer.send = send  # type: ignore[method-assign]
        self.peers.append(peer)
        return peer

    @property
    def peer(self) -> FakePeer:
        return self.peers[-1]

    def phone(self, channel: str, message: dict[str, Any]) -> None:
        host = self.pc.host
        assert host is not None
        host.post(lambda: self.peer.phone(channel, message))

    async def aclose(self) -> None:
        await self.process.aclose()
        await self.pc.close_direct()
        await self.pc.stop_input()


@pytest.fixture
async def rig() -> AsyncIterator[ThreadRig]:
    instance = ThreadRig()
    instance.pc.start()
    yield instance
    await instance.aclose()


async def wait_for(predicate: Callable[[], bool], seconds: float = 3.0) -> None:
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "a condição não ficou verdadeira a tempo"
        await asyncio.sleep(0.005)


async def open_on_the_lane(rig: ThreadRig, scopes: list[str]) -> None:
    host = rig.pc.host
    direct = rig.pc.direct
    assert host is not None and direct is not None
    await host.call(lambda: direct.open(SESSION, SDP, TOKEN, 30, None, scopes=scopes))
    rig.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
    await wait_for(lambda: bool(rig.peers) and any(m.get("k") == "ready" for _, m in rig.peer.sent))
    for n in (1, 2):
        rig.phone(POINTER_CHANNEL, {"k": "ping", "n": n, "t": int(time.time() * 1000)})
    await wait_for(
        lambda: any(m.get("c") is True for c, m in rig.peer.sent if c == POINTER_CHANNEL)
    )


def tv_message(key: str, command_id: str) -> dict[str, Any]:
    return TvLab.command("tv.key.v2", {"key": key}, command_id)


async def test_the_key_runs_on_the_main_loop_and_the_ack_goes_out_on_the_input_loop(
    rig: ThreadRig,
) -> None:
    await open_on_the_lane(rig, ["tv"])
    rig.threads.clear()
    main = threading.current_thread().name

    rig.phone(INPUT_CHANNEL, tv_message("OK", "k1"))
    await wait_for(lambda: bool(rig.peer.acks()))

    assert rig.tv.keys == [("OK", "SHORT")]
    assert rig.tv.threads == {main}  # a sessão da TV vive no laço principal
    assert set(rig.threads) == {"uniover-pc-input"}  # e a resposta sai do laço da entrada
    assert rig.peer.acks()[0]["ok"] is True


async def test_a_blocked_main_loop_never_blocks_the_input_loop_and_the_excess_is_refused(
    rig: ThreadRig,
) -> None:
    await open_on_the_lane(rig, ["tv"])
    rig.peer.sent.clear()

    for n in range(40):
        rig.phone(INPUT_CHANNEL, tv_message("UP", f"k{n}"))
    rig.phone(POINTER_CHANNEL, {"k": "ping", "n": 9, "t": int(time.time() * 1000)})
    # O laço principal parado (a falta de memória medida em produção): `sleep` libera o GIL.
    time.sleep(0.5)  # noqa: ASYNC251

    # Sem ceder a vez ao laço principal: a entrada respondeu o sinal de vida e recusou o excesso.
    pongs = [m for c, m in rig.peer.sent if c == POINTER_CHANNEL and m.get("k") == "pong"]
    refused = [m for m in rig.peer.acks() if m.get("c") == "rate_limited"]
    assert [m["n"] for m in pongs] == [9]
    assert len(refused) == 10  # 30 por segundo passam; o excesso é recusado na hora, sem acumular
    assert rig.tv.keys == []  # e a TV, que vive no laço principal, ainda não viu nada


async def test_keys_that_waited_for_a_stopped_main_loop_are_discarded_by_age(
    rig: ThreadRig,
) -> None:
    await open_on_the_lane(rig, ["tv"])
    rig.phone(INPUT_CHANNEL, tv_message("UP", "k1"))
    time.sleep(1.8)  # noqa: ASYNC251
    await wait_for(lambda: bool(rig.peer.acks()), seconds=4.0)

    # Passou de 1,5 s esperando o laço principal: a tecla não é apertada fora de hora.
    assert rig.tv.keys == []
    assert rig.peer.acks()[0]["c"] == "agent_timeout"


async def test_the_bridge_refuses_at_the_cap_instead_of_queueing_without_limit() -> None:
    results: list[CommandResult] = []
    parked: list[Any] = []
    bridge = TvDirectBridge(
        lambda command, received_at, on_result, valid: None,
        to_main=lambda callback, *args: parked.append((callback, args)),  # o laço principal parado
        to_lane=lambda callback: callback(),
        max_pending=2,
    )
    for n in range(4):
        bridge.submit(Command(f"c{n}", "tv.key.v2", {"key": "UP"}), 0.0, results.append)

    assert bridge.pending == 2 and len(parked) == 2
    assert [(r.command_id, r.code) for r in results] == [("c2", "busy"), ("c3", "busy")]


async def test_the_bridge_frees_the_slot_when_the_delivery_fails() -> None:
    lane_calls: list[Callable[[], None]] = []
    results: list[CommandResult] = []

    def broken(
        command: Command,
        received_at: float,
        on_result: Callable[..., None],
        valid: Callable[[], bool],
    ) -> None:
        raise RuntimeError("falha da entrega")

    bridge = TvDirectBridge(
        broken,
        to_main=lambda callback, *args: callback(*args),
        to_lane=lane_calls.append,
        max_pending=1,
    )
    bridge.submit(Command("c1", "tv.key.v2", {"key": "UP"}), 0.0, results.append)

    assert bridge.pending == 1
    lane_calls.pop()()  # o laço do canal recebe a falha e libera a vaga
    assert bridge.pending == 0
    assert (results[0].status, results[0].code) == (ResultStatus.FAILED, "failed")


async def test_the_main_loop_caller_is_what_the_composition_uses_between_loops() -> None:
    # A ponte usa `MainLoopCaller` e `PcInputThread.post`: os dois nunca bloqueiam.
    loop = asyncio.get_running_loop()
    hop = MainLoopCaller(loop)
    host = PcInputThread(name="uniover-bridge-test")
    host.start()
    try:
        seen: list[str] = []
        done = asyncio.Event()

        def on_main() -> None:
            seen.append(threading.current_thread().name)
            done.set()

        host.post(lambda: hop(on_main))
        await asyncio.wait_for(done.wait(), 2)
        assert seen == [threading.current_thread().name]
    finally:
        await asyncio.to_thread(host.stop)


# ---- a capacidade: só com TV, canal direto do PC e depois de a API listá-la --------------------


def test_the_capability_waits_for_the_api_to_list_it() -> None:
    assert TV_RTC_CAPABILITY == "tv.rtc.v1"
    assert declarable_capabilities([TV_RTC_CAPABILITY], lambda feature: False) == ()
    assert declarable_capabilities([TV_RTC_CAPABILITY], lambda feature: True) == (
        TV_RTC_CAPABILITY,
    )


def test_without_the_direct_channel_the_pc_has_nothing_to_bind_the_tv_to() -> None:
    pc = build_pc(
        Settings(pc_control=True, pc_direct=False),
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock()),
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
        audio=FakeAudio(),
        gate=EnvelopeGate(AGENT_ID),
        agent_id=AGENT_ID,
    )
    assert pc is not None and pc.direct is None
    assert pc.bind_tv_direct(lambda command, received_at, on_result, valid: None) is False


def test_tv_direct_is_on_by_default_and_can_be_turned_off() -> None:
    assert Settings(pc_control=True).tv_direct is True
    assert Settings(pc_control=True, tv_direct=False).tv_direct is False


async def test_a_close_asked_by_the_api_still_reports_what_the_tv_channel_carried(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    for n in range(3):
        peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, f"k{n}"))
    await settle()

    await lab.service.close(SESSION, "requested")
    await settle_close()

    # A API já sabe que fechou, mas a soma da TV só chega à trilha por este aviso.
    assert lab.closed == [(SESSION, "requested", TvCounts(keys=3, texts=0))]


async def test_replacing_a_tv_channel_reports_its_sum_too(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k1"))
    await settle()

    await lab.service.open(
        "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e02", SDP, TOKEN, 30, None, scopes=["tv"]
    )

    assert lab.closed == [(SESSION, "replaced", TvCounts(keys=1, texts=0))]


# ---- a revogação não deixa passar o que já estava na fila ------------------------------------


async def test_a_key_already_in_the_tv_queue_is_dropped_when_the_channel_is_revoked(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    for n in range(3):
        peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "RIGHT"}, f"k{n}"))
    await settle()

    await lab.service.close(SESSION, "revoked")
    lab.tv.gate.set()
    await settle()

    assert lab.tv.keys == []  # nenhuma das três chegou à TV depois da revogação
    assert lab.process._key_tasks == set() or all(t.done() for t in lab.process._key_tasks)


async def test_a_text_waiting_behind_a_key_is_dropped_when_the_channel_is_revoked(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "OK"}, "k1"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.text.v1", {"text": "senha"}, "t1"))
    await settle()

    await lab.service.close(SESSION, "revoked")
    lab.tv.gate.set()
    await settle()

    assert lab.tv.keys == [] and lab.tv.texts == []


async def test_the_process_refuses_a_direct_key_whose_session_already_closed(lab: TvLab) -> None:
    results: list[CommandResult] = []
    lab.process.submit_direct_tv(
        Command("c1", "tv.key.v2", {"key": "UP"}), time.monotonic(), results.append, lambda: False
    )
    await settle()

    assert lab.tv.keys == []
    assert [(r.status, r.code) for r in results] == [(ResultStatus.REJECTED, "channel_closed")]


async def test_revoking_with_keys_parked_in_the_bridge_executes_none_of_them(
    rig: ThreadRig,
) -> None:
    await open_on_the_lane(rig, ["tv"])
    host = rig.pc.host
    direct = rig.pc.direct
    assert host is not None and direct is not None

    for n in range(10):
        rig.phone(INPUT_CHANNEL, tv_message("UP", f"k{n}"))
    # A revogação chega (laço da entrada) com o laço principal parado: as teclas ficaram na ponte.
    closing: list[asyncio.Future[None]] = []

    def revoke() -> None:
        closing.append(asyncio.ensure_future(direct.close(SESSION, "revoked")))

    host.post(revoke)
    time.sleep(0.5)  # noqa: ASYNC251

    assert direct.session_id is None
    assert rig.tv.keys == []  # o laço principal ainda não viu nada
    await asyncio.sleep(0.3)  # o laço principal volta e processa o que a ponte deixou

    assert rig.tv.keys == []  # e, ao voltar, nenhuma delas é apertada


async def test_the_bridge_releases_the_slot_of_a_key_whose_session_closed() -> None:
    lane_calls: list[Callable[[], None]] = []
    results: list[CommandResult] = []
    delivered: list[str] = []
    alive = True

    def deliver(
        command: Command,
        received_at: float,
        on_result: Callable[..., None],
        valid: Callable[[], bool],
    ) -> None:
        delivered.append(command.id)

    bridge = TvDirectBridge(
        deliver,
        to_main=lambda callback, *args: callback(*args),
        to_lane=lane_calls.append,
        max_pending=2,
    )
    alive = False
    bridge.submit(Command("c1", "tv.key.v2", {"key": "UP"}), 0.0, results.append, lambda: alive)

    assert delivered == []  # nunca entregue à sessão da TV
    lane_calls.pop()()
    assert bridge.pending == 0
    assert [(r.status, r.code) for r in results] == [(ResultStatus.REJECTED, "channel_closed")]


async def test_a_text_that_waited_for_its_turn_is_not_typed_after_the_revocation(
    lab: TvLab,
) -> None:
    peer = await lab.open(["tv"])
    lab.tv.text_gate = asyncio.Event()
    peer.phone(INPUT_CHANNEL, lab.command("tv.text.v1", {"text": "primeiro"}, "t1"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.text.v1", {"text": "segundo"}, "t2"))
    await settle()  # o primeiro segura a vez; o segundo espera atrás dele

    await lab.service.close(SESSION, "revoked")
    lab.tv.text_gate.set()
    await settle()

    assert lab.tv.texts == []  # nenhum dos dois é digitado depois da revogação


async def test_the_text_handler_checks_the_session_after_getting_the_turn_and_before_the_tv() -> (
    None
):
    tv = FakeTv()
    tv.text_gate = asyncio.Event()
    handler = tv_text_handler(tv, reconciler=FakeReconciler(tv))  # type: ignore[arg-type]
    alive = {"ok": True}

    def command(command_id: str, text: str) -> ValidatedCommand:
        return ValidatedCommand(
            command_id, "tv.text.v1", {"text": text}, is_valid=lambda: alive["ok"]
        )

    first = asyncio.ensure_future(handler(command("a", "um")))
    await asyncio.sleep(0)
    second = asyncio.ensure_future(handler(command("b", "dois")))
    await asyncio.sleep(0)
    alive["ok"] = False  # revogado com a primeira em curso e a segunda esperando a vez
    tv.text_gate.set()
    results = await asyncio.gather(first, second)

    assert tv.texts == []
    assert [r.code for r in results] == ["channel_closed", "channel_closed"]


async def test_only_what_the_tv_confirmed_is_summed_for_the_trail(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k1"))
    await settle()
    lab.tv.refuse_with = TvSessionError("TV_UNREACHABLE", "fora")
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k2"))
    peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "UP"}, "k3"))
    await settle()

    await lab.service._finish(lab.service._current, "idle")  # type: ignore[arg-type]
    await settle_close()

    assert lab.closed == [(SESSION, "idle", TvCounts(keys=1, texts=0))]


async def test_keys_dropped_by_the_revocation_are_not_counted(lab: TvLab) -> None:
    peer = await lab.open(["tv"])
    lab.tv.gate = asyncio.Event()
    for n in range(3):
        peer.phone(INPUT_CHANNEL, lab.command("tv.key.v2", {"key": "RIGHT"}, f"k{n}"))
    await settle()

    await lab.service.close(SESSION, "revoked")
    lab.tv.gate.set()
    await settle_close()

    assert lab.tv.keys == []
    assert lab.closed == []  # nada confirmado: nada a somar na trilha
