"""Ciclo de vida da medição junto ao canal existente, com dois pares falsos."""

import asyncio
from collections.abc import AsyncIterator

import pytest

from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.core.pc.direct import DirectRefused

from .test_pc_direct import SESSION, Lab, _Approvals, settle

_DEVICE = "iphone-da-casa"
_SCREEN = "sessao-tela"


class FakeScreen:
    def __init__(self) -> None:
        self.offers: list[tuple[str, str, int, int]] = []
        self.stopped = asyncio.Event()

    async def accept_offer(self, sdp: str, token: str, ttl: int, lifetime: int) -> str:
        self.offers.append((sdp, token, ttl, lifetime))
        return "ANSWER-SCREEN"

    def stop(self) -> None:
        self.stopped.set()

    async def wait(self) -> None:
        await self.stopped.wait()


@pytest.fixture
async def measurement() -> AsyncIterator[tuple[Lab, FakeScreen]]:
    screen = FakeScreen()
    lab = Lab(screen_factory=lambda: screen)
    lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]
    try:
        yield lab, screen
    finally:
        await lab.aclose()


async def offer(lab: Lab, parent: str = SESSION, device: str | None = _DEVICE) -> str:
    return await lab.service.open(
        _SCREEN,
        "OFFER-SCREEN",
        "TOKEN-SCREEN",
        15,
        900,
        scopes=["screen"],
        parent_session_id=parent,
        device_id=device,
    )


async def test_measurement_requires_live_authenticated_parent_and_same_device(
    measurement: tuple[Lab, FakeScreen],
) -> None:
    lab, screen = measurement
    with pytest.raises(DirectRefused):
        await offer(lab)
    await lab.open(device_id=_DEVICE)
    with pytest.raises(DirectRefused):
        await offer(lab)
    await lab.open_authenticated(session="novo-pc", device_id=_DEVICE, clock=False)
    with pytest.raises(DirectRefused):
        await offer(lab)
    with pytest.raises(DirectRefused):
        await offer(lab, parent="novo-pc", device="outro-iphone")
    with pytest.raises(DirectRefused):
        await offer(lab, parent="novo-pc", device=None)
    assert screen.offers == []


@pytest.mark.parametrize("close_trigger", ["screen", "parent", "api"])
async def test_measurement_is_a_second_peer_and_follows_parent_lifetime(
    measurement: tuple[Lab, FakeScreen], close_trigger: str
) -> None:
    lab, screen = measurement
    parent = await lab.open_authenticated(device_id=_DEVICE, clock=False)
    assert await offer(lab) == "ANSWER-SCREEN"
    assert screen.offers == [("OFFER-SCREEN", "TOKEN-SCREEN", 15, 90)]
    assert lab.peer is parent and lab.service.authenticated
    with pytest.raises(DirectRefused):
        await offer(lab)
    if close_trigger == "api":
        lab.service.api_disconnected()
    else:
        await lab.service.close(SESSION if close_trigger == "parent" else _SCREEN)
    assert screen.stopped.is_set()
    assert lab.service.authenticated == (close_trigger != "parent")


async def test_measurement_exit_notifies_signaling_without_ending_control(
    measurement: tuple[Lab, FakeScreen],
) -> None:
    lab, screen = measurement
    await lab.open_authenticated(device_id=_DEVICE, clock=False)
    await offer(lab)
    screen.stopped.set()
    await settle()
    assert lab.closed == [(_SCREEN, "requested")]
    assert lab.service.authenticated
    with pytest.raises(DirectRefused):
        await offer(lab)
