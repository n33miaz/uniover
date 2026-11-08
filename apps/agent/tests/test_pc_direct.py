"""Canal direto (WebRTC) do controle do PC: token, esquema, faixa, soltura e prazos (sem rede)."""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.core import (
    ClockOffset,
    DirectSettings,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    PcDirectService,
    PcUseTracker,
    ProcessMessage,
    pc_handlers,
    pc_rtc_handlers,
)
from uniover_agent.core.pc.direct import (
    REFUSED_FAILED,
    REFUSED_UNAVAILABLE,
    RTC_SILENT_TYPES,
    RTC_TYPES,
    DirectRefused,
)
from uniover_agent.ports import (
    INPUT_CHANNEL,
    POINTER_CHANNEL,
    DirectPeerFactory,
    DirectUnavailable,
    PeerCallbacks,
)

from .support import AGENT_ID, dump, envelope

SESSION = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01"
TOKEN = "q3Vx9Zk2mP7sT1wY4bN8cR5dF6gH0jLa"
SDP = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA\r\n"


class FakeInput:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def move(self, dx: int, dy: int) -> None:
        self.calls.append(("move", dx, dy))

    def scroll(self, horizontal: int, vertical: int) -> None:
        self.calls.append(("scroll", horizontal, vertical))

    def click(self, button: str, action: str) -> None:
        self.calls.append(("click", button, action))

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        self.calls.append(("key", key, tuple(modifiers), repeat, action))

    def type_text(self, text: str) -> None:
        self.calls.append(("text", text))

    def media(self, action: str, steps: int) -> None:
        self.calls.append(("media", action, steps))

    def release_all(self) -> None:
        self.calls.append(("release_all",))


class FakePower:
    def lock(self) -> None: ...
    def sleep(self) -> None: ...
    def shutdown(self, delay_seconds: int) -> None: ...
    def cancel_shutdown(self) -> None: ...


class FakeLauncher:
    def launch(self, target: str) -> None: ...


class FakePeer:
    """O par WebRTC de mentira: guarda o que o agente manda e deixa o teste falar pelo celular."""

    def __init__(self, callbacks: PeerCallbacks) -> None:
        self.callbacks = callbacks
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.closed = False
        self.offers: list[str] = []
        self.candidates: list[tuple[str, str | None, int | None]] = []
        self.refuse: Exception | None = None

    async def accept_offer(self, sdp: str) -> str:
        if self.refuse is not None:
            raise self.refuse
        self.offers.append(sdp)
        return "ANSWER-SDP"

    async def add_candidate(self, candidate: str, mid: str | None, index: int | None) -> None:
        self.candidates.append((candidate, mid, index))

    def send(self, channel: str, text: str) -> bool:
        self.sent.append((channel, json.loads(text)))
        return True

    async def close(self) -> None:
        self.closed = True

    def phone(self, channel: str, message: dict[str, Any] | str) -> None:
        text = message if isinstance(message, str) else json.dumps(message)
        self.callbacks.on_message(channel, text)

    def acks(self) -> list[dict[str, Any]]:
        return [m for c, m in self.sent if c == INPUT_CHANNEL and m.get("k") == "ack"]


class Lab:
    """Serviço, faixa do PC e handlers de verdade, com PC falso e par falso."""

    def __init__(
        self,
        settings: DirectSettings | None = None,
        ttl: int = 30,
        *,
        block_clicks: bool = False,
        factory: DirectPeerFactory | None = None,
    ) -> None:
        self.clock = FakeClock()
        self.gate = EnvelopeGate(AGENT_ID)
        self.transport = FakeTransport()
        self.envelopes = EnvelopeFactory(AGENT_ID, self.gate, self.clock)
        self.pc = FakeInput()
        self.api_clock = ClockOffset()
        handlers = pc_handlers(
            self.pc,
            FakePower(),
            FakeLauncher(),
            [],
            shutdown_delay_seconds=30,
            clock=self.api_clock,
            use=PcUseTracker(),
        )
        self.click_gate = asyncio.Event()
        if block_clicks:
            inner = handlers["pc.click.v1"]

            async def slow_click(command: Any) -> Any:
                await self.click_gate.wait()
                return await inner(command)

            handlers["pc.click.v1"] = slow_click
        self.peers: list[FakePeer] = []
        self.closed: list[tuple[str, str]] = []
        self.records: list[tuple[str, str, str]] = []
        self.ttl = ttl

        async def notify(session_id: str, reason: str) -> None:
            self.closed.append((session_id, reason))

        self.service = PcDirectService(
            factory=factory or self._factory,
            agent_id=AGENT_ID,
            gate=self.gate,
            api_clock=self.api_clock,
            notify_closed=notify,
            record=lambda kind, severity, detail: self.records.append((kind, severity, detail)),
            settings=settings or DirectSettings(tick_seconds=0.005),
        )
        handlers.update(pc_rtc_handlers(self.service, self.transport, self.envelopes))
        # A faixa e os `pc.rtc.*` usam os mesmos handlers do agente de verdade.
        self.process = ProcessMessage(
            AGENT_ID,
            self.gate,
            HandleCommand(handlers, self.clock),
            self.envelopes,
            self.transport,
            background_types=RTC_TYPES,
            silent_types={"pc.pointer.v1", *RTC_SILENT_TYPES},
            release_inputs=self.pc.release_all,
        )
        self.service.bind(self.process.submit_direct, self.process.direct_lost)

    def _factory(self, callbacks: PeerCallbacks) -> FakePeer:
        peer = FakePeer(callbacks)
        self.peers.append(peer)
        return peer

    @property
    def peer(self) -> FakePeer:
        return self.peers[-1]

    async def open(self, token: str = TOKEN, session: str = SESSION) -> str:
        return await self.service.open(session, SDP, token, self.ttl)

    async def open_authenticated(self) -> FakePeer:
        await self.open()
        self.peer.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
        await settle()
        return self.peer

    def command(
        self, message_type: str, body: dict[str, Any], command_id: str = "c1"
    ) -> dict[str, Any]:
        return {
            "k": "cmd",
            "i": command_id,
            "t": message_type,
            "b": body,
            "ts": int(time.time() * 1000),
            "p": {"s": 0, "x": 0, "y": 0, "w": 0, "h": 0},
        }

    async def aclose(self) -> None:
        await self.service.aclose()
        await self.process.aclose()


async def settle() -> None:
    for _ in range(30):
        await asyncio.sleep(0)
    await asyncio.sleep(0.01)


@pytest.fixture
async def lab() -> AsyncIterator[Lab]:
    instance = Lab()
    yield instance
    await instance.aclose()


# ---- token e abertura --------------------------------------------------------------------------


async def test_offer_returns_the_answer_and_waits_for_the_token(lab: Lab) -> None:
    answer = await lab.open()

    assert answer == "ANSWER-SDP"
    assert lab.peer.offers == [SDP]
    assert lab.service.session_id == SESSION
    assert not lab.service.authenticated


async def test_first_message_with_the_right_token_authenticates(lab: Lab) -> None:
    peer = await lab.open_authenticated()

    assert lab.service.authenticated
    assert (INPUT_CHANNEL, {"k": "ready"}) in peer.sent


@pytest.mark.parametrize(
    "first",
    [
        {"k": "auth", "tok": "outro-token-qualquer-com-tamanho-ok-1234"},
        {"k": "auth"},
        {"k": "cmd", "i": "x", "t": "pc.key.v1", "b": {"key": "A"}},
        {"k": "ping", "n": 1},
    ],
)
async def test_a_wrong_or_missing_token_closes_the_channel(lab: Lab, first: dict[str, Any]) -> None:
    await lab.open()
    lab.peer.phone(INPUT_CHANNEL, first)
    await settle()

    assert lab.peer.closed
    assert lab.service.session_id is None
    # Nunca comandou nada: não há o que soltar (e o que veio pela nuvem não é tocado).
    assert lab.pc.calls == []
    assert lab.closed == [(SESSION, "failed")]


async def test_an_expired_token_is_refused() -> None:
    lab = Lab(ttl=0)
    try:
        await lab.open()
        await asyncio.sleep(0.03)
        lab.peer.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
        await settle()

        assert lab.peer.closed
        assert not lab.service.authenticated
    finally:
        await lab.aclose()


async def test_the_pointer_is_dropped_until_the_token_is_accepted(lab: Lab) -> None:
    await lab.open()
    lab.peer.phone(POINTER_CHANNEL, {"k": "ptr", "s": 1, "x": 50, "y": 0, "w": 0, "h": 0})
    await settle()

    assert lab.pc.calls == []


async def test_the_token_is_single_use_per_session_and_a_second_auth_is_a_violation(
    lab: Lab,
) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, {"k": "auth", "tok": TOKEN})
    await settle()

    assert lab.service.authenticated  # um auth repetido não derruba nem repete o "ready"
    assert [m for _, m in peer.sent if m.get("k") == "ready"] == [{"k": "ready"}]


async def test_an_offer_the_peer_cannot_take_is_refused_with_a_stable_code(lab: Lab) -> None:
    # A fábrica entrega um par que recusa; o serviço devolve o código estável e não deixa sessão.
    original = lab._factory

    def refusing(callbacks: PeerCallbacks) -> FakePeer:
        peer = original(callbacks)
        peer.refuse = DirectUnavailable("sem biblioteca")
        return peer

    lab.service._factory = refusing
    with pytest.raises(DirectRefused) as unavailable:
        await lab.open()
    assert unavailable.value.code == REFUSED_UNAVAILABLE
    assert lab.service.session_id is None

    def broken(callbacks: PeerCallbacks) -> FakePeer:
        peer = original(callbacks)
        peer.refuse = ValueError("oferta ruim")
        return peer

    lab.service._factory = broken
    with pytest.raises(DirectRefused) as failed:
        await lab.open()
    assert failed.value.code == REFUSED_FAILED


# ---- ponteiro ----------------------------------------------------------------------------------


def ptr(seq: int, x: int, y: int = 0, w: int = 0, h: int = 0, **extra: Any) -> dict[str, Any]:
    return {"k": "ptr", "s": seq, "x": x, "y": y, "w": w, "h": h, **extra}


async def test_pointer_totals_become_relative_moves_and_survive_a_lost_message(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, ptr(1, 10, 5))
    peer.phone(POINTER_CHANNEL, ptr(3, 30, 5))  # a 2 se perdeu: o total traz a soma
    await settle()

    assert lab.pc.calls == [("move", 10, 5), ("move", 20, 0)]


async def test_a_late_or_repeated_pointer_message_is_ignored(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, ptr(2, 20))
    peer.phone(POINTER_CHANNEL, ptr(1, 10))  # chegou depois de uma mais nova
    peer.phone(POINTER_CHANNEL, ptr(2, 20))  # repetida
    await settle()

    assert lab.pc.calls == [("move", 20, 0)]


async def test_scroll_totals_are_applied_and_a_huge_jump_is_split_by_the_contract_limits(
    lab: Lab,
) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, ptr(1, 5000, 0, 0, -240))
    await settle()

    assert lab.pc.calls == [
        ("move", 2000, 0),
        ("scroll", 0, -240),
        ("move", 2000, 0),
        ("move", 1000, 0),
    ]


async def test_a_still_pointer_sends_nothing_but_a_heartbeat_keeps_the_hold_alive(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, ptr(1, 0))
    peer.phone(POINTER_CHANNEL, ptr(2, 0, hb=1))
    await settle()

    assert lab.pc.calls == [("move", 0, 0)]


async def test_a_pointer_message_that_is_not_an_integer_is_a_violation_not_a_move(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, {"k": "ptr", "s": 1, "x": "10", "y": 0, "w": 0, "h": 0})
    peer.phone(POINTER_CHANNEL, {"k": "ptr", "s": True, "x": 1, "y": 0, "w": 0, "h": 0})
    await settle()

    assert lab.pc.calls == []


async def test_the_pointer_channel_answers_pings_and_keeps_the_rtt_for_the_summary(
    lab: Lab,
) -> None:
    peer = await lab.open_authenticated()
    now_ms = int(time.time() * 1000)
    peer.phone(POINTER_CHANNEL, {"k": "ping", "n": 7, "t": now_ms, "r": 12})
    await settle()

    assert (POINTER_CHANNEL, {"k": "pong", "n": 7}) in peer.sent
    await lab.service.close(SESSION)
    # O resumo vai ao diagnóstico em faixas fixas, sem identificador, endereço nem número exato.
    [(kind, severity, detail)] = lab.records
    assert (kind, severity) == ("pc.direct_closed", "info")
    assert "abaixo de 30 ms" in detail
    assert SESSION not in detail


# ---- comandos ----------------------------------------------------------------------------------


async def test_a_click_runs_through_the_same_handlers_and_is_acknowledged(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.click.v1", {"button": "LEFT", "action": "DOWN"}))
    await settle()

    assert lab.pc.calls == [("click", "LEFT", "DOWN")]
    assert peer.acks() == [{"k": "ack", "i": "c1", "ok": True}]
    # Nada do canal direto vai para a API: nem o resultado do comando.
    assert [m["type"] for m in lab.transport.sent] == []


async def test_the_pointer_snapshot_of_a_command_is_applied_before_it(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    command = lab.command("pc.click.v1", {"button": "LEFT"})
    command["p"] = {"s": 4, "x": 40, "y": -3, "w": 0, "h": 0}
    peer.phone(INPUT_CHANNEL, command)  # o canal do ponteiro ainda não entregou nada
    peer.phone(POINTER_CHANNEL, ptr(4, 40, -3))  # chega depois: já aplicado, não repete
    await settle()

    assert lab.pc.calls == [("move", 40, -3), ("click", "LEFT", "CLICK")]


async def test_commands_keep_their_order_with_the_pointer(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(POINTER_CHANNEL, ptr(1, 10))
    down = lab.command("pc.click.v1", {"button": "LEFT", "action": "DOWN"}, "d")
    down["p"] = {"s": 1, "x": 10, "y": 0, "w": 0, "h": 0}
    peer.phone(INPUT_CHANNEL, down)
    peer.phone(POINTER_CHANNEL, ptr(2, 25))
    up = lab.command("pc.click.v1", {"button": "LEFT", "action": "UP"}, "u")
    up["p"] = {"s": 2, "x": 25, "y": 0, "w": 0, "h": 0}
    peer.phone(INPUT_CHANNEL, up)
    await settle()

    assert lab.pc.calls == [
        ("move", 10, 0),
        ("click", "LEFT", "DOWN"),
        ("move", 15, 0),
        ("click", "LEFT", "UP"),
    ]


@pytest.mark.parametrize(
    ("message_type", "body", "code"),
    [
        ("pc.power.v1", {"action": "SHUTDOWN"}, "not_allowed"),
        ("pc.app.launch.v1", {"appId": "x"}, "not_allowed"),
        ("tv.key.v1", {"key": "POWER"}, "not_allowed"),
        ("pc.click.v1", {"button": "X"}, "invalid_message"),
        ("pc.key.v1", {"key": "A", "modifiers": ["CTRL", "CTRL"]}, "invalid_message"),
        ("pc.text.v1", {"text": ""}, "invalid_message"),
    ],
)
async def test_what_the_cloud_would_refuse_is_refused_here_too(
    lab: Lab, message_type: str, body: dict[str, Any], code: str
) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command(message_type, body))
    await settle()

    assert lab.pc.calls == []
    assert peer.acks() == [{"k": "ack", "i": "c1", "ok": False, "c": code}]


async def test_text_keys_media_and_the_v2_key_all_go_through(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.text.v1", {"text": "olá"}, "t"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.key.v1", {"key": "ENTER"}, "k1"))
    peer.phone(
        INPUT_CHANNEL,
        lab.command("pc.key.v2", {"key": "TAB", "modifiers": ["ALT"], "repeat": 3}, "k2"),
    )
    peer.phone(INPUT_CHANNEL, lab.command("pc.key.v2", {"key": "ALT", "action": "DOWN"}, "k3"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.key.v2", {"key": "ALT", "action": "UP"}, "k4"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "m"))
    await settle()

    assert lab.pc.calls == [
        ("text", "olá"),
        ("key", "ENTER", (), 1, "PRESS"),
        ("key", "TAB", ("ALT",), 3, "PRESS"),
        ("key", "ALT", (), 1, "DOWN"),
        ("key", "ALT", (), 1, "UP"),
        ("media", "MUTE", 1),
    ]
    assert [a["i"] for a in peer.acks()] == ["t", "k1", "k2", "k3", "k4", "m"]
    assert all(a["ok"] for a in peer.acks())


async def test_an_old_command_expires_by_the_age_the_phone_clock_shows_but_an_up_never_does(
    lab: Lab,
) -> None:
    peer = await lab.open_authenticated()
    now_ms = int(time.time() * 1000)
    for n in (1, 2):  # dois pings que concordam firmam a escala de relógio do app
        peer.phone(POINTER_CHANNEL, {"k": "ping", "n": n, "t": now_ms})
    old = now_ms - 10_000
    stale_click = lab.command("pc.click.v1", {"button": "LEFT"}, "old")
    stale_click["ts"] = old
    stale_key = lab.command("pc.key.v2", {"key": "ALT", "action": "UP"}, "up")
    stale_key["ts"] = old
    stale_release = lab.command("pc.click.v1", {"button": "LEFT", "action": "UP"}, "up2")
    stale_release["ts"] = old
    for message in (stale_click, stale_key, stale_release):
        peer.phone(INPUT_CHANNEL, message)
    await settle()

    assert lab.pc.calls == [("key", "ALT", (), 1, "UP"), ("click", "LEFT", "UP")]
    acks = {a["i"]: a for a in peer.acks()}
    assert acks["old"] == {"k": "ack", "i": "old", "ok": False, "c": "expired"}
    assert acks["up"]["ok"] and acks["up2"]["ok"]


async def test_the_typed_text_never_reaches_the_log(
    lab: Lab, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.text.v1", {"text": "senha-secreta-123"}))
    peer.phone(INPUT_CHANNEL, lab.command("pc.click.v1", {"button": "senha-secreta-123"}, "x"))
    peer.phone(INPUT_CHANNEL, "{ senha-secreta-123 ")
    await settle()
    await lab.service.close(SESSION)

    assert "senha-secreta-123" not in caplog.text
    assert TOKEN not in caplog.text


async def test_flooding_the_input_channel_is_cut_by_the_rate_limit() -> None:
    lab = Lab(DirectSettings(tick_seconds=0.005, max_input_per_second=2))
    try:
        peer = await lab.open_authenticated()
        for n in range(5):
            peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, f"m{n}"))
        await settle()

        assert len(lab.pc.calls) == 2
        refused = [a for a in peer.acks() if not a["ok"]]
        assert {a["c"] for a in refused} == {"rate_limited"}
    finally:
        await lab.aclose()


async def test_garbage_closes_the_channel_after_a_run_of_violations(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    for _ in range(30):
        peer.phone(POINTER_CHANNEL, "isto não é json")
    await settle()

    assert peer.closed
    assert lab.closed == [(SESSION, "failed")]


async def test_a_command_with_an_unhashable_type_is_refused_not_a_crash(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, {"k": "cmd", "i": "x", "t": ["pc.key.v1"], "b": {"key": "A"}})
    await settle()

    assert peer.acks() == [{"k": "ack", "i": "x", "ok": False, "c": "not_allowed"}]
    assert lab.pc.calls == []


async def test_oversized_messages_are_dropped(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, json.dumps({"k": "cmd", "pad": "x" * 5000}))
    await settle()

    assert lab.pc.calls == []
    assert not peer.closed


# ---- fechar solta o que o PC segurava ----------------------------------------------------------


async def test_closing_the_channel_releases_what_the_pc_held(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.click.v1", {"button": "LEFT", "action": "DOWN"}, "d"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.key.v2", {"key": "ALT", "action": "DOWN"}, "a"))
    await settle()
    lab.pc.calls.clear()

    peer.callbacks.on_closed()  # o par caiu (consentimento do ICE, rede, página fechada)
    await settle()

    assert lab.pc.calls == [("release_all",)]
    assert lab.service.session_id is None
    assert lab.closed == [(SESSION, "failed")]
    assert peer.closed


async def test_a_message_after_the_close_does_nothing(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    await lab.service.close(SESSION)
    lab.pc.calls.clear()
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}))
    peer.phone(POINTER_CHANNEL, ptr(9, 9))
    await settle()

    assert lab.pc.calls == []


async def test_closing_drops_what_the_channel_still_had_waiting_in_the_lane(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "m1"))
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "m2"))
    # Sem ceder a vez: a faixa ainda não executou nada quando o canal fecha.
    await lab.service.close(SESSION)
    await settle()

    assert ("media", "MUTE", 1) not in lab.pc.calls
    assert lab.pc.calls == [("release_all",)]


async def test_what_came_by_the_cloud_is_not_dropped_when_the_channel_closes(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    peer.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}, "d"))
    cloud = dump(
        envelope(
            "pc.media.v1",
            {"action": "STOP"},
            ts=lab.service._fresh_stamp(),
        )
    )
    await lab.process(cloud)
    await lab.service.close(SESSION)
    await settle()

    assert ("media", "STOP", 1) in lab.pc.calls
    assert ("media", "MUTE", 1) not in lab.pc.calls


async def test_a_new_offer_replaces_the_channel_and_releases_what_it_held(lab: Lab) -> None:
    first = await lab.open_authenticated()
    await lab.service.open("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e02", SDP, TOKEN, 30)

    assert first.closed
    assert lab.pc.calls[-1] == ("release_all",)
    assert lab.service.session_id == "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e02"
    first.phone(INPUT_CHANNEL, lab.command("pc.media.v1", {"action": "MUTE"}))
    await settle()
    assert ("media", "MUTE", 1) not in lab.pc.calls
    assert lab.closed == []  # a troca veio da API, que já sabe: nada de aviso de volta


async def test_losing_the_api_connection_closes_the_channel_without_telling_the_api(
    lab: Lab,
) -> None:
    peer = await lab.open_authenticated()
    lab.service.api_disconnected()
    await settle()

    assert peer.closed
    assert lab.pc.calls == [("release_all",)]
    assert lab.closed == []


async def test_a_close_for_another_session_is_ignored(lab: Lab) -> None:
    peer = await lab.open_authenticated()
    await lab.service.close("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8eff")

    assert not peer.closed
    assert lab.service.authenticated


# ---- prazos ------------------------------------------------------------------------------------


async def test_a_channel_that_never_authenticates_closes_by_the_connect_timeout() -> None:
    lab = Lab(DirectSettings(connect_timeout_seconds=0.05, tick_seconds=0.005))
    try:
        await lab.open()
        await asyncio.sleep(0.15)

        assert lab.peer.closed
        assert lab.closed == [(SESSION, "connect_timeout")]
    finally:
        await lab.aclose()


async def test_a_silent_channel_closes_by_the_idle_timeout_and_a_busy_one_does_not() -> None:
    lab = Lab(DirectSettings(idle_seconds=0.08, tick_seconds=0.005))
    try:
        peer = await lab.open_authenticated()
        for n in range(1, 8):  # um sinal de vida a cada 20 ms mantém o canal
            peer.phone(POINTER_CHANNEL, {"k": "ping", "n": n, "t": int(time.time() * 1000)})
            await asyncio.sleep(0.02)
        assert not peer.closed

        await asyncio.sleep(0.2)
        assert peer.closed
        assert lab.closed == [(SESSION, "idle")]
        assert lab.pc.calls == [("release_all",)]
    finally:
        await lab.aclose()


# ---- candidatos e sinalização pela faixa do agente ---------------------------------------------


async def test_late_candidates_reach_the_peer_but_local_names_do_not(lab: Lab) -> None:
    await lab.open()
    await lab.service.add_candidate(
        SESSION, "candidate:1 1 udp 1 192.168.1.9 5000 typ host", "0", 0
    )
    await lab.service.add_candidate(
        SESSION, "candidate:2 1 udp 1 abc-123.local 5000 typ host", "0", 0
    )
    await lab.service.add_candidate(
        "outra-sessao", "candidate:3 1 udp 1 10.0.0.1 5 typ host", None, None
    )

    assert lab.peer.candidates == [("candidate:1 1 udp 1 192.168.1.9 5000 typ host", "0", 0)]


def offer_envelope(session: str = SESSION, token: str = TOKEN) -> str:
    body = {"sessionId": session, "sdp": SDP, "token": token, "tokenTtlSeconds": 30}
    return dump(envelope("pc.rtc.offer.v1", body, ts="2026-11-08T12:00:00.000Z"))


async def test_the_offer_is_answered_before_the_result_and_never_waits_for_the_lane() -> None:
    lab = Lab(block_clicks=True)
    try:
        # Uma tecla da nuvem presa na faixa não pode segurar a sinalização do canal.
        await lab.process(
            dump(
                envelope(
                    "pc.click.v1",
                    {"button": "LEFT", "action": "DOWN"},
                    ts=lab.service._fresh_stamp(),
                )
            )
        )
        await lab.process(offer_envelope())
        await settle()

        types = [m["type"] for m in lab.transport.sent]
        assert types == ["pc.rtc.answer.v1", "command.result.v1"]
        answer, result = lab.transport.sent
        assert answer["body"] == {"sessionId": SESSION, "sdp": "ANSWER-SDP"}
        assert answer["correlationId"] == result["correlationId"]
        assert result["body"] == {"ok": True}
        assert lab.service.session_id == SESSION
    finally:
        lab.click_gate.set()
        await lab.aclose()


async def test_a_refused_offer_answers_with_the_stable_code_and_no_answer_message(lab: Lab) -> None:
    original = lab._factory

    def refusing(callbacks: PeerCallbacks) -> FakePeer:
        peer = original(callbacks)
        peer.refuse = DirectUnavailable("sem biblioteca")
        return peer

    lab.service._factory = refusing
    await lab.process(offer_envelope())
    await settle()

    [result] = lab.transport.sent
    assert result["type"] == "command.result.v1"
    assert result["body"]["ok"] is False
    assert result["body"]["error"]["code"] == "rtc_unavailable"


async def test_close_and_candidate_messages_from_the_api_are_silent(lab: Lab) -> None:
    await lab.open_authenticated()
    candidate = {
        "sessionId": SESSION,
        "candidate": "candidate:1 1 udp 1 192.168.1.9 5000 typ host",
        "sdpMLineIndex": 0,
    }
    await lab.process(
        dump(envelope("pc.rtc.candidate.v1", candidate, ts="2026-11-08T12:00:00.000Z"))
    )
    await lab.process(
        dump(envelope("pc.rtc.close.v1", {"sessionId": SESSION}, ts="2026-11-08T12:00:00.000Z"))
    )
    await settle()

    assert lab.peer.candidates
    assert lab.peer.closed
    assert lab.transport.sent == []  # sem resultado: a API não espera por eles
    assert lab.pc.calls == [("release_all",)]


async def test_an_offer_with_a_wrong_target_or_a_bad_token_shape_never_reaches_the_service(
    lab: Lab,
) -> None:
    bad = envelope(
        "pc.rtc.offer.v1",
        {"sessionId": SESSION, "sdp": SDP, "token": "curto", "tokenTtlSeconds": 30},
        ts="2026-11-08T12:00:00.000Z",
    )
    await lab.process(dump(bad))
    await settle()

    assert lab.peers == []
    [result] = lab.transport.sent
    assert result["body"]["ok"] is False
