"""Montagem do canal direto: capacidade só com biblioteca e configuração, e só se a API listar."""

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.composition.connection import declarable_capabilities
from uniover_agent.composition.pc import PcSetup, build_pc
from uniover_agent.config import Settings
from uniover_agent.core import (
    PC_RTC_CAPABILITY,
    RECONCILE_CAPABILITY,
    EnvelopeFactory,
    EnvelopeGate,
)
from uniover_agent.core.pc.direct import ReconcileClaim

from .support import AGENT_ID, FakeAudio
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
        audio=FakeAudio(),
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
    assert settings.pc_direct_reconcile_seconds == 10.0


def test_with_the_library_it_declares_the_capability_and_handles_the_signaling() -> None:
    pc = build(Settings())

    assert pc is not None
    assert pc.direct is not None
    assert PC_RTC_CAPABILITY in pc.capabilities
    assert RECONCILE_CAPABILITY in pc.capabilities
    assert {
        "pc.rtc.offer.v1",
        "pc.rtc.candidate.v1",
        "pc.rtc.close.v1",
        "pc.rtc.reconciled.v1",
    } <= set(pc.handlers)


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
    assert RECONCILE_CAPABILITY not in pc.capabilities
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


def test_the_hello_only_declares_the_reconcile_after_the_api_lists_it() -> None:
    assert RECONCILE_CAPABILITY == "pc.rtc.reconcile.v1"
    # Uma API anterior recusaria o `hello` com a capacidade (a lista do contrato é fechada).
    assert declarable_capabilities([RECONCILE_CAPABILITY], lambda _: False) == ()
    assert declarable_capabilities([RECONCILE_CAPABILITY], lambda c: c == RECONCILE_CAPABILITY) == (
        RECONCILE_CAPABILITY,
    )


async def test_the_declaration_goes_out_as_a_message_that_fits_the_contract() -> None:
    transport = FakeTransport()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())
    pc = build_pc(
        Settings(),
        transport,
        envelopes,
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
        audio=FakeAudio(),
        gate=EnvelopeGate(AGENT_ID),
        agent_id=AGENT_ID,
        direct_available=lambda: True,
    )
    assert pc is not None and pc.direct is not None

    await pc.direct._announce_reconcile(  # type: ignore[misc]
        ReconcileClaim(
            session_id="0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01",
            ticket="eyJ2IjoxLCJzaWQiOiJ4In0." + "q3Vx9Zk2mP7sT1wY4bN8cR5dF6gH0jLaZ9xKpQwErT1",
        )
    )

    [sent] = transport.sent
    assert sent["type"] == "pc.rtc.reconcile.v1"
    assert sent["body"]["sessions"][0]["sessionId"] == "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01"
