"""Canal direto depois de a API reiniciar: o agente conta o canal que segurou e a API o reconhece.

A API reiniciada perde o registro das sessões do canal, e uma revogação não acharia um canal que o
agente segue segurando. Ao reconectar, o agente (que sabe `pc.rtc.reconcile.v1`) declara o canal e
fecha se a API não o reconhecer a tempo.
"""

import asyncio
import dataclasses
from collections.abc import AsyncIterator
from typing import Any

import pytest

from uniover_agent.core import Command, DirectSettings, pc_rtc_handlers
from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.core.pc.direct import REASON_RESCOPED, RECONCILED_TYPE, ReconcileClaim
from uniover_agent.ports import INPUT_CHANNEL

from .support import dump, envelope
from .test_pc_direct import SESSION, Lab, _Approvals, settle, settle_close

# O bilhete é opaco para o agente: ele só o guarda e o devolve (o formato é o do contrato).
TICKET = "eyJ2IjoxLCJzaWQiOiJ4In0." + "q3Vx9Zk2mP7sT1wY4bN8cR5dF6gH0jLaZ9xKpQwErT1"
DEVICE = "3fa9c10d7be2465a"
WINDOW = 0.15

IDENTITY: dict[str, Any] = {
    "ticket": TICKET,
    "device_id": DEVICE,
    "device_name": "iPhone",
}


@pytest.fixture
async def lab() -> AsyncIterator[Lab]:
    instance = Lab()
    yield instance
    await instance.aclose()


def settings(**changes: Any) -> DirectSettings:
    return DirectSettings(tick_seconds=0.005, reconcile_seconds=WINDOW, **changes)


async def test_reconnecting_returns_the_open_channel_with_the_ticket_the_api_gave() -> None:
    lab = Lab(settings())
    try:
        lab.service._tv = lambda *args: None
        await lab.open_authenticated(**IDENTITY, scopes=["pc", "tv"])

        lab.service.api_reconnected(reconcile=True)
        await settle()

        [claim] = lab.claims
        assert isinstance(claim, ReconcileClaim)
        # Só o id e o bilhete: quem abriu, a sessão de login, os escopos e a TV estão no bilhete.
        assert (claim.session_id, claim.ticket) == (SESSION, TICKET)
        assert {f.name for f in dataclasses.fields(claim)} == {"session_id", "ticket"}
    finally:
        await lab.aclose()


async def test_the_confirmation_keeps_the_channel_past_the_deadline() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await settle()

        lab.service.confirm_reconciled(SESSION)
        await asyncio.sleep(WINDOW * 2)

        assert not peer.closed
        assert lab.service.authenticated
        assert lab.closed == []
    finally:
        await lab.aclose()


async def test_without_the_confirmation_the_channel_closes_and_the_api_is_told() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await asyncio.sleep(WINDOW * 2.5)

        assert peer.closed
        assert lab.service.session_id is None
        assert lab.closed == [(SESSION, "disconnected")]
        assert lab.pc.calls[-1] == ("release_all",)  # o que o PC segurava é solto
    finally:
        await lab.aclose()


async def test_a_confirmation_for_another_session_does_not_save_the_channel() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        lab.service.confirm_reconciled("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8eff")
        await asyncio.sleep(WINDOW * 2.5)

        assert peer.closed
    finally:
        await lab.aclose()


async def test_an_api_that_does_not_list_the_capability_changes_nothing() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected()  # sem `reconcile`: o comportamento de sempre
        await asyncio.sleep(WINDOW * 2.5)

        assert lab.claims == []
        assert not peer.closed
    finally:
        await lab.aclose()


async def test_with_no_channel_nothing_is_declared(lab: Lab) -> None:
    lab.service.api_reconnected(reconcile=True)
    await settle()

    assert lab.claims == []


async def test_a_channel_opened_without_the_ticket_cannot_be_recognised_and_is_reopened() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated()  # a oferta de antes da capacidade: sem `ticket`
        lab.service.api_reconnected(reconcile=True)
        await settle_close()

        assert lab.claims == []  # a API não teria como provar que o canal foi dela
        assert peer.closed
        assert lab.closed == [(SESSION, REASON_RESCOPED)]
        assert (INPUT_CHANNEL, {"k": "bye", "r": REASON_RESCOPED}) in peer.sent  # o app abre outro
    finally:
        await lab.aclose()


async def test_a_revocation_during_the_wait_closes_at_once_and_stops_the_timer() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await settle()
        await lab.service.close(SESSION, "revoked")

        assert peer.closed
        assert lab.service._reconcile is None  # nada fica esperando por um canal que já fechou
        await asyncio.sleep(WINDOW * 2)
        assert lab.closed == []  # a API que mandou fechar não é avisada de volta
    finally:
        await lab.aclose()


async def test_dropping_the_connection_again_cancels_the_wait_and_the_grace_takes_over() -> None:
    lab = Lab(settings(api_grace_seconds=5))
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await settle()
        lab.service.api_disconnected()
        await asyncio.sleep(WINDOW * 2.5)

        assert (
            not peer.closed
        )  # a espera da confirmação acabou com a conexão; a queda tem o prazo dela
        assert lab.service._reconcile is None
        assert lab.service._grace is not None

        lab.service.api_reconnected(reconcile=True)  # a próxima conexão declara de novo
        await settle()
        assert len(lab.claims) == 2
    finally:
        await lab.aclose()


async def test_a_device_the_owner_stopped_approving_loses_the_pc_but_not_the_tv() -> None:
    lab = Lab(settings())
    try:
        lab.service._tv = lambda *args: None
        peer = await lab.open_authenticated(**IDENTITY, scopes=["pc", "tv"])
        lab.service._devices = _Approvals(DeviceDecision.DENIED)  # type: ignore[assignment]
        lab.service.api_reconnected(reconcile=True)
        await settle_close()

        assert lab.claims == []
        assert peer.closed
        assert lab.closed == [(SESSION, REASON_RESCOPED)]  # o app reabre só com a TV
    finally:
        await lab.aclose()


async def test_a_pc_only_channel_with_a_device_no_longer_approved_is_revoked() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        approvals = _Approvals(DeviceDecision.DENIED)
        lab.service._devices = approvals  # type: ignore[assignment]
        lab.service.api_reconnected(reconcile=True)
        await settle_close()

        assert approvals.checked == [(DEVICE, "iPhone")]
        assert peer.closed
        assert lab.closed == [(SESSION, "revoked")]
    finally:
        await lab.aclose()


async def test_a_failed_declaration_still_ends_in_the_close() -> None:
    lab = Lab(settings())

    async def broken(claim: Any) -> None:
        raise RuntimeError("fora do ar")

    lab.service._announce_reconcile = broken
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await asyncio.sleep(WINDOW * 2.5)

        assert peer.closed  # sem a mensagem a API não confirma: o prazo fecha
    finally:
        await lab.aclose()


# ---- os handlers e a mensagem ------------------------------------------------------------------


async def test_the_offer_handler_keeps_the_ticket_for_the_reconcile(lab: Lab) -> None:
    handlers = pc_rtc_handlers(lab.service, lab.transport, lab.envelopes)
    command = Command(
        "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e77",
        "pc.rtc.offer.v1",
        {
            "sessionId": SESSION,
            "sdp": "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA\r\n",
            "token": "q3Vx9Zk2mP7sT1wY4bN8cR5dF6gH0jLa",
            "tokenTtlSeconds": 30,
            "maxLifetimeSeconds": 600,
            "ticket": TICKET,
        },
    )
    await handlers["pc.rtc.offer.v1"](command)

    lab.service.api_reconnected(reconcile=True)
    await settle()
    [claim] = lab.claims
    assert claim.ticket == TICKET


async def test_the_reconciled_message_from_the_api_confirms_the_channel() -> None:
    lab = Lab(settings())
    try:
        peer = await lab.open_authenticated(**IDENTITY)
        lab.service.api_reconnected(reconcile=True)
        await settle()

        await lab.process(
            dump(
                envelope(
                    RECONCILED_TYPE,
                    {"sessionIds": [SESSION]},
                    ts="2026-11-11T12:00:00.000Z",
                )
            )
        )
        await asyncio.sleep(WINDOW * 2)

        assert not peer.closed
        assert lab.transport.sent == []  # sem resultado: a API não espera por ele
    finally:
        await lab.aclose()


def test_the_message_the_agent_builds_fits_the_contract(lab: Lab) -> None:
    message = lab.envelopes.pc_rtc_reconcile(SESSION, TICKET)

    assert message["type"] == "pc.rtc.reconcile.v1"
    assert message["body"] == {"sessions": [{"sessionId": SESSION, "ticket": TICKET}]}


def test_the_default_window_is_ten_seconds() -> None:
    assert DirectSettings().reconcile_seconds == 10.0
