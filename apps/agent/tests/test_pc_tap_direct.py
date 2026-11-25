"""O toque na tela do PC pelo canal direto: só com a tela aberta, na ordem, dentro da validade.

O ponteiro é um dublê que só anota: nada aqui chega ao Windows.
"""

import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

import pytest

from uniover_agent.core.pc.absolute import STALE_LAYOUT, AbsoluteTarget, LayoutChanged
from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.ports.pc_direct import INPUT_CHANNEL, POINTER_CHANNEL

from .support import dump, envelope
from .test_pc_direct import SESSION, FakePeer, Lab, _Approvals, settle
from .test_pc_screen_lifecycle import _DEVICE, _SCREEN, FakeScreen, offer

SIZE = {"w": 2560, "h": 1440}


class FakeAbsolute:
    """O ponteiro absoluto de mentira: anota cada posição e cada toque."""

    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.stale = False

    def move_to(self, target: AbsoluteTarget) -> None:
        if self.stale:
            raise LayoutChanged
        self.calls.append(("move_to", target.monitor, target.u, target.v))

    def tap(
        self, target: AbsoluteTarget, button: str, action: str, modifiers: Sequence[str] = ()
    ) -> None:
        if self.stale and action != "UP":
            raise LayoutChanged
        self.calls.append(("tap", target.monitor, target.u, target.v, button, action))


class TapLab:
    def __init__(self, *, absolute: bool = True) -> None:
        self.screen = FakeScreen()
        self.pointer = FakeAbsolute()
        self.lab = Lab(
            screen_factory=lambda: self.screen, absolute=self.pointer if absolute else None
        )
        self.lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]

    async def control(self) -> FakePeer:
        return await self.lab.open_authenticated(device_id=_DEVICE)

    async def with_screen(self) -> FakePeer:
        peer = await self.control()
        await offer(self.lab)
        return peer

    def tap(self, action: str = "CLICK", i: str = "t1", **extra: Any) -> dict[str, Any]:
        body = {"m": 1, "u": 100, "v": 200, **SIZE, "button": "LEFT", "action": action}
        body.update(extra.pop("body", {}))
        message = self.lab.command("pc.tap.v1", body, i)
        message.update(extra)
        return message

    @staticmethod
    def abs(seq: int, u: int = 10, **extra: Any) -> dict[str, Any]:
        return {"k": "abs", "s": seq, "m": 1, "u": u, "v": 0, **SIZE, **extra}


@pytest.fixture
async def taps() -> AsyncIterator[TapLab]:
    lab = TapLab()
    try:
        yield lab
    finally:
        await lab.lab.aclose()


def _ack(peer: FakePeer, command_id: str) -> dict[str, Any]:
    return next(a for a in peer.acks() if a["i"] == command_id)


def _ready(peer: FakePeer) -> dict[str, Any]:
    return next(m for c, m in peer.sent if c == INPUT_CHANNEL and m.get("k") == "ready")


async def test_the_channel_lists_the_tap_only_on_an_agent_that_knows_it() -> None:
    knows, older = TapLab(), TapLab(absolute=False)
    try:
        assert {"pc.tap.v1", "pc.pointer.abs.v1"} <= set(_ready(await knows.control())["caps"])
        assert "pc.tap.v1" not in _ready(await older.control())["caps"]
    finally:
        await knows.lab.aclose()
        await older.lab.aclose()


async def test_without_the_screen_open_on_this_channel_nothing_moves_or_clicks(
    taps: TapLab,
) -> None:
    peer = await taps.control()
    peer.phone(INPUT_CHANNEL, taps.tap())
    peer.phone(POINTER_CHANNEL, taps.abs(1))
    await settle()
    assert _ack(peer, "t1") == {"k": "ack", "i": "t1", "ok": False, "c": "not_allowed"}
    assert taps.pointer.calls == []
    # Não é abuso (a tela pode ter acabado de fechar): o canal segue aberto.
    assert taps.lab.service.authenticated


async def test_with_the_screen_open_the_tap_and_the_drag_reach_the_pointer(taps: TapLab) -> None:
    peer = await taps.with_screen()
    peer.phone(INPUT_CHANNEL, taps.tap("DOWN", "d"))
    await settle()
    peer.phone(POINTER_CHANNEL, taps.abs(1, u=500))
    await settle()
    # Duas posições que esperam juntas na faixa: só a mais nova sai (o ponteiro vai direto a ela).
    peer.phone(POINTER_CHANNEL, taps.abs(2, u=700))
    peer.phone(POINTER_CHANNEL, taps.abs(3, u=900))
    await settle()
    peer.phone(INPUT_CHANNEL, taps.tap("UP", "u", body={"u": 900}, a=3))
    await settle()
    assert taps.pointer.calls == [
        ("tap", 1, 100, 200, "LEFT", "DOWN"),
        ("move_to", 1, 500, 0),
        ("move_to", 1, 900, 0),
        ("tap", 1, 900, 200, "LEFT", "UP"),
    ]
    assert _ack(peer, "d")["ok"] and _ack(peer, "u")["ok"]


async def test_a_late_position_never_moves_the_pointer_back(taps: TapLab) -> None:
    peer = await taps.with_screen()
    peer.phone(POINTER_CHANNEL, taps.abs(5, u=50))
    peer.phone(POINTER_CHANNEL, taps.abs(3, u=30))  # chegou depois da 5, no canal sem ordem
    peer.phone(POINTER_CHANNEL, taps.abs(5, u=50))  # repetida
    await settle()
    # O toque leva o maior número que o app já mandou: a 7, que vem atrás, já não vale.
    peer.phone(INPUT_CHANNEL, taps.tap(a=7))
    await settle()
    peer.phone(POINTER_CHANNEL, taps.abs(7, u=70))
    peer.phone(POINTER_CHANNEL, taps.abs(8, u=80))
    await settle()
    assert taps.pointer.calls == [
        ("move_to", 1, 50, 0),
        ("tap", 1, 100, 200, "LEFT", "CLICK"),
        ("move_to", 1, 80, 0),
    ]


async def test_an_old_tap_expires_but_letting_go_always_passes(taps: TapLab) -> None:
    peer = await taps.with_screen()
    old = int(time.time() * 1000) - 10_000
    peer.phone(INPUT_CHANNEL, taps.tap("CLICK", "velho", ts=old))
    peer.phone(INPUT_CHANNEL, taps.tap("UP", "solta", ts=old))
    await settle()
    assert _ack(peer, "velho")["c"] == "expired"
    assert _ack(peer, "solta")["ok"]
    assert taps.pointer.calls == [("tap", 1, 100, 200, "LEFT", "UP")]


async def test_letting_go_passes_even_after_the_screen_closed(taps: TapLab) -> None:
    peer = await taps.with_screen()
    peer.phone(INPUT_CHANNEL, taps.tap("DOWN", "d"))
    await settle()
    await taps.lab.service.close(_SCREEN)
    peer.phone(POINTER_CHANNEL, taps.abs(1))
    peer.phone(INPUT_CHANNEL, taps.tap("CLICK", "c"))
    peer.phone(INPUT_CHANNEL, taps.tap("UP", "u"))
    await settle()
    assert _ack(peer, "c")["c"] == "not_allowed"
    assert _ack(peer, "u")["ok"]
    assert taps.pointer.calls == [
        ("tap", 1, 100, 200, "LEFT", "DOWN"),
        ("tap", 1, 100, 200, "LEFT", "UP"),
    ]


async def test_a_changed_layout_is_refused_with_its_own_code(taps: TapLab) -> None:
    peer = await taps.with_screen()
    taps.pointer.stale = True
    peer.phone(INPUT_CHANNEL, taps.tap())
    await settle()
    assert _ack(peer, "t1")["c"] == STALE_LAYOUT


@pytest.mark.parametrize(
    "body",
    [{"u": 65536}, {"v": -1}, {"m": True}, {"m": 64}, {"w": 0}, {"u": 0.5}, {"action": "HOLD"}],
)
async def test_values_outside_the_contract_are_refused_on_the_channel(
    taps: TapLab, body: dict[str, Any]
) -> None:
    peer = await taps.with_screen()
    peer.phone(INPUT_CHANNEL, taps.tap(body=body))
    await settle()
    assert _ack(peer, "t1")["c"] == "invalid_message"
    assert taps.pointer.calls == []


@pytest.mark.parametrize(
    "extra", [{"s": 0}, {"s": 2_147_483_648}, {"s": True}, {"u": 70_000}, {"m": "1"}, {"h": None}]
)
async def test_positions_outside_the_contract_count_as_violations(
    taps: TapLab, extra: dict[str, Any]
) -> None:
    peer = await taps.with_screen()
    before = taps.lab.service._current.violations  # type: ignore[union-attr]
    peer.phone(POINTER_CHANNEL, {**taps.abs(1), **extra})
    await settle()
    assert taps.pointer.calls == []
    assert taps.lab.service._current.violations == before + 1  # type: ignore[union-attr]


async def test_an_agent_without_the_absolute_pointer_refuses_the_tap() -> None:
    lab = TapLab(absolute=False)
    try:
        peer = await lab.with_screen()
        peer.phone(INPUT_CHANNEL, lab.tap())
        peer.phone(POINTER_CHANNEL, lab.abs(1))
        await settle()
        assert _ack(peer, "t1")["c"] == "not_allowed"
        assert lab.pointer.calls == []
    finally:
        await lab.lab.aclose()


async def test_a_tv_only_channel_never_carries_the_tap(taps: TapLab) -> None:
    await taps.control()
    await offer(taps.lab)
    tv_only = TapLab()
    try:
        tv_only.lab.service._tv = lambda *_args: None
        peer = await tv_only.lab.open_authenticated(device_id=_DEVICE, scopes=["tv"])
        peer.phone(INPUT_CHANNEL, tv_only.tap())
        await settle()
        assert _ack(peer, "t1")["c"] == "not_allowed"
        assert tv_only.pointer.calls == []
    finally:
        await tv_only.lab.aclose()


@pytest.mark.parametrize("message_type", ["pc.tap.v1", "pc.pointer.abs.v1"])
async def test_from_the_cloud_the_tap_is_refused_and_the_channel_stays(
    taps: TapLab, message_type: str
) -> None:
    await taps.with_screen()
    body: dict[str, Any] = {"m": 1, "u": 1, "v": 1, **SIZE}
    body |= {"button": "LEFT", "action": "CLICK"} if message_type == "pc.tap.v1" else {"seq": 1}
    cloud = envelope(message_type, body, ts=taps.lab.service._stamp(0.0))
    await taps.lab.process(dump(cloud))
    await settle()
    assert taps.pointer.calls == []
    assert taps.lab.service.session_id == SESSION
    (result,) = [m for m in taps.lab.transport.sent if m["type"] == "command.result.v1"]
    assert result["body"]["error"]["code"] == "not_allowed"
