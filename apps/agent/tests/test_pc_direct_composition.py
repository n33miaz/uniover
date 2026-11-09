"""Montagem do canal direto: capacidade só com biblioteca e configuração, e só se a API listar."""

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.composition.connection import declarable_capabilities
from uniover_agent.composition.pc import PcSetup, build_pc
from uniover_agent.config import Settings
from uniover_agent.core import PC_RTC_CAPABILITY, EnvelopeFactory, EnvelopeGate

from .support import AGENT_ID
from .test_pc_composition import FakeInput, FakeLauncher, FakePower, hello_capabilities


def build(settings: Settings, *, available: bool = True, gate: bool = True) -> PcSetup | None:
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())
    return build_pc(
        settings,
        FakeTransport(),
        envelopes,
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
        gate=EnvelopeGate(AGENT_ID) if gate else None,
        agent_id=AGENT_ID,
        direct_available=lambda: available,
    )


def test_the_direct_channel_is_on_by_default_and_has_prudent_deadlines() -> None:
    settings = Settings()

    assert settings.pc_direct is True
    assert settings.pc_direct_connect_timeout_seconds == 15.0
    assert settings.pc_direct_idle_seconds == 20.0
    assert settings.pc_direct_max_lifetime_seconds == 900.0


def test_with_the_library_it_declares_the_capability_and_handles_the_signaling() -> None:
    pc = build(Settings())

    assert pc is not None
    assert pc.direct is not None
    assert PC_RTC_CAPABILITY in pc.capabilities
    assert {"pc.rtc.offer.v1", "pc.rtc.candidate.v1", "pc.rtc.close.v1"} <= set(pc.handlers)


@pytest.mark.parametrize(
    ("settings", "available"),
    [
        (Settings(pc_direct=False), True),  # desligado neste PC
        (Settings(), False),  # sem a biblioteca instalada
    ],
)
def test_without_the_setting_or_the_library_nothing_about_it_exists(
    settings: Settings, available: bool
) -> None:
    pc = build(settings, available=available)

    assert pc is not None
    assert pc.direct is None
    assert PC_RTC_CAPABILITY not in pc.capabilities
    assert not any(name.startswith("pc.rtc.") for name in pc.handlers)


def test_the_key_and_pointer_handlers_are_the_same_with_or_without_it() -> None:
    with_direct = build(Settings())
    without = build(Settings(pc_direct=False))

    assert with_direct is not None and without is not None
    assert {n for n in with_direct.handlers if not n.startswith("pc.rtc.")} == set(without.handlers)


def test_the_hello_only_declares_it_after_the_api_lists_it() -> None:
    listed = {PC_RTC_CAPABILITY}

    assert PC_RTC_CAPABILITY not in declarable_capabilities([PC_RTC_CAPABILITY], lambda _: False)
    assert declarable_capabilities([PC_RTC_CAPABILITY], listed.__contains__) == (PC_RTC_CAPABILITY,)


async def test_the_real_hello_waits_for_the_api_to_list_pc_rtc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older_api = frozenset({"agent.diagnostics.v1", "pc.key.v2"})

    assert PC_RTC_CAPABILITY not in await hello_capabilities(monkeypatch, older_api)
    assert PC_RTC_CAPABILITY in await hello_capabilities(
        monkeypatch, older_api | {PC_RTC_CAPABILITY}
    )
