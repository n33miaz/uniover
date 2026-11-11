"""O canal direto de verdade, com o `aiortc` dos dois lados no mesmo processo (só loopback).

Nada toca a rede local nem o desktop: os candidatos são só `127.0.0.1` (o `aioice` aqui é limitado a
ele) e o PC é falso. Serve também de teste de contrato do `av` falso: se uma atualização do `aiortc`
passar a exigir o pacote de verdade, o canal de dados deixa de abrir aqui.
"""

import asyncio
import contextlib
import importlib
import json
import sys
import time
from typing import Any

import pytest

from uniover_agent.adapters import pc_direct_aiortc, pc_direct_network, pc_direct_stub_av
from uniover_agent.adapters.pc_direct_aiortc import (
    aiortc_installed,
    build_peer,
    prepare_offer,
)
from uniover_agent.core.pc import lan
from uniover_agent.ports.pc_direct import PeerCallbacks

from .test_pc_direct import SESSION, TOKEN, Lab

pytestmark = pytest.mark.skipif(not aiortc_installed(), reason="aiortc não está instalado")

OFFER = (
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n"
    "a=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 udp 1 abc-123.local 5000 typ host\r\n"
    "a=candidate:2 1 udp 1 192.168.1.9 5000 typ host\r\na=sctp-port:5000\r\n"
)


def test_the_offer_loses_its_local_names_and_keeps_the_rest() -> None:
    prepared = prepare_offer(OFFER)

    assert ".local" not in prepared
    assert "192.168.1.9" in prepared
    assert "a=fingerprint:sha-256 AA:BB" in prepared
    assert prepared.endswith("\r\n")


@pytest.mark.parametrize(
    "offer",
    [
        OFFER.replace("a=fingerprint:sha-256 AA:BB\r\n", ""),
        OFFER + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        "v=0\r\ns=-\r\n",
    ],
)
def test_an_offer_without_the_fingerprint_or_with_media_is_refused(offer: str) -> None:
    with pytest.raises(ValueError, match="oferta"):
        prepare_offer(offer)


def test_the_fake_av_lets_aiortc_import_without_the_real_package() -> None:
    pc_direct_stub_av.install()
    pc_direct_stub_av.install()  # uma vez só

    module = importlib.import_module("av")

    assert module.__name__ == "av"
    assert module.AudioFrame is not None
    assert sum(isinstance(f, pc_direct_stub_av._Finder) for f in sys.meta_path) == 1


@pytest.fixture
def loopback_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """O celular de mentira é este mesmo processo: só 127.0.0.1, aceito pela política de endereços."""
    if "aiortc" not in pc_direct_aiortc._loaded:
        # Carrega antes (a carga instala a política de endereços da rede local); o teste vem depois dela.
        pc_direct_aiortc._loaded["aiortc"] = pc_direct_aiortc._import_aiortc()

    def addresses(use_ipv4: bool, use_ipv6: bool) -> list[str]:
        return ["127.0.0.1"]

    monkeypatch.setattr("aioice.ice.get_host_addresses", addresses)
    monkeypatch.setattr(lan, "ALLOW_LOOPBACK", True)


class Phone:
    """O celular: um `aiortc` com os dois canais de dados, como o app os abre."""

    def __init__(self, aiortc: Any) -> None:
        self.connection = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        self.pointer = self.connection.createDataChannel("pointer", ordered=False, maxRetransmits=0)
        self.input = self.connection.createDataChannel("input", ordered=True)
        self.inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.opened = asyncio.Event()
        self.aiortc = aiortc
        self.pongs: list[dict[str, Any]] = []
        self.input.on("message", lambda text: self.inbox.put_nowait(json.loads(text)))
        self.pointer.on("message", self._on_pointer_message)
        self.pointer.on("open", self._check)
        self.input.on("open", self._check)

    def _on_pointer_message(self, text: str) -> None:
        message = json.loads(text)
        if message.get("k") == "pong":
            self.pongs.append(message)

    def _check(self) -> None:
        if self.pointer.readyState == "open" and self.input.readyState == "open":
            self.opened.set()

    async def offer(self) -> str:
        await self.connection.setLocalDescription(await self.connection.createOffer())
        return str(self.connection.localDescription.sdp)

    async def accept(self, answer: str) -> None:
        await self.connection.setRemoteDescription(
            self.aiortc.RTCSessionDescription(sdp=answer, type="answer")
        )

    async def next(self) -> dict[str, Any]:
        return await asyncio.wait_for(self.inbox.get(), 10)


async def close_quietly(phone: Phone) -> None:
    with contextlib.suppress(Exception):
        await asyncio.wait_for(phone.connection.close(), 3)


async def test_a_real_peer_opens_authenticates_and_drives_the_pc(loopback_only: None) -> None:
    aiortc = await pc_direct_aiortc._load()
    lab = Lab(factory=build_peer)
    phone = Phone(aiortc)
    try:
        offer = await phone.offer()
        answer = await asyncio.wait_for(lab.service.open(SESSION, offer, TOKEN, 30), 20)
        assert "a=fingerprint:sha-256" in answer
        await phone.accept(answer)
        await asyncio.wait_for(phone.opened.wait(), 20)

        phone.input.send(json.dumps({"k": "auth", "tok": TOKEN}))
        ready = await phone.next()
        assert ready["k"] == "ready"
        assert 0 < ready["life"] <= 900

        # Dois sinais de vida firmam a escala de relógio; só então a entrada é aceita.
        for n in (1, 2):
            phone.pointer.send(json.dumps({"k": "ping", "n": n, "t": int(time.time() * 1000)}))
            await asyncio.sleep(0.05)
        for _ in range(100):
            if phone.pongs and phone.pongs[-1].get("c") is True:
                break
            await asyncio.sleep(0.05)
        assert phone.pongs[-1]["c"] is True

        phone.pointer.send(json.dumps({"k": "ptr", "s": 1, "x": 12, "y": -4, "w": 0, "h": 0}))
        click = {
            "k": "cmd",
            "i": "c1",
            "t": "pc.click.v1",
            "b": {"button": "LEFT", "action": "DOWN"},
            "ts": int(time.time() * 1000),
            "p": {"s": 1, "x": 12, "y": -4, "w": 0, "h": 0},
        }
        phone.input.send(json.dumps(click))
        assert await phone.next() == {"k": "ack", "i": "c1", "ok": True}
        assert lab.pc.calls == [("move", 12, -4), ("click", "LEFT", "DOWN")]

        # O celular some (aba fechada, rede perdida): o PC solta o botão que ficou apertado. O
        # fechamento do celular de mentira roda solto: com os dois pares no mesmo laço, ele pode
        # demorar a terminar.
        vanishing = asyncio.create_task(phone.connection.close())
        for _ in range(150):
            if ("release_all",) in lab.pc.calls:
                break
            await asyncio.sleep(0.1)
        assert lab.pc.calls[-1] == ("release_all",)
        vanishing.cancel()
    finally:
        await close_quietly(phone)
        await lab.aclose()


async def test_a_real_peer_with_the_wrong_token_is_closed_and_nothing_runs(
    loopback_only: None,
) -> None:
    aiortc = await pc_direct_aiortc._load()
    lab = Lab(factory=build_peer)
    phone = Phone(aiortc)
    try:
        offer = await phone.offer()
        answer = await asyncio.wait_for(lab.service.open(SESSION, offer, TOKEN, 30), 20)
        await phone.accept(answer)
        await asyncio.wait_for(phone.opened.wait(), 20)

        phone.pointer.send(json.dumps({"k": "ptr", "s": 1, "x": 99, "y": 0, "w": 0, "h": 0}))
        phone.input.send(json.dumps({"k": "auth", "tok": "x" * 32}))
        for _ in range(100):
            if lab.service.session_id is None:
                break
            await asyncio.sleep(0.1)

        assert lab.service.session_id is None
        assert [c for c in lab.pc.calls if c[0] != "release_all"] == []
    finally:
        await close_quietly(phone)
        await lab.aclose()


async def test_a_real_peer_refuses_extra_or_unknown_channels(loopback_only: None) -> None:
    aiortc = await pc_direct_aiortc._load()
    lab = Lab(factory=build_peer)
    phone = Phone(aiortc)
    stray = phone.connection.createDataChannel("outro")
    try:
        offer = await phone.offer()
        answer = await asyncio.wait_for(lab.service.open(SESSION, offer, TOKEN, 30), 20)
        await phone.accept(answer)
        await asyncio.wait_for(phone.opened.wait(), 20)
        for _ in range(100):
            if stray.readyState == "closed":
                break
            await asyncio.sleep(0.1)

        assert stray.readyState != "open"
    finally:
        await close_quietly(phone)
        await lab.aclose()


def test_the_library_is_loaded_with_the_local_network_address_policy() -> None:
    import aioice.ice

    pc_direct_aiortc._loaded.pop("aiortc", None)
    pc_direct_aiortc._loaded["aiortc"] = pc_direct_aiortc._import_aiortc()

    assert aioice.ice.get_host_addresses is pc_direct_network.lan_host_addresses


def test_the_offer_of_a_real_peer_loses_its_public_and_odd_candidates() -> None:
    offer = OFFER.replace(
        "a=sctp-port:5000",
        "a=candidate:3 1 udp 1 203.0.114.5 5000 typ srflx raddr 0.0.0.0 rport 0\r\n"
        "a=candidate:4 1 udp 1 2001:4860::1 5000 typ host\r\na=sctp-port:5000",
    )

    prepared = prepare_offer(offer)

    assert "203.0.114.5" not in prepared
    assert "2001:4860" not in prepared
    assert "192.168.1.9" in prepared


async def test_a_peer_that_reaches_us_from_outside_the_local_network_is_dropped(
    loopback_only: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # O celular de mentira chega por 127.0.0.1 (peer-reflexive, já que a oferta foi limpa): sem a
    # permissão de loopback, o par escolhido não é "da rede local" e o canal é derrubado.
    monkeypatch.setattr(lan, "ALLOW_LOOPBACK", False)
    aiortc = await pc_direct_aiortc._load()
    lab = Lab(factory=build_peer)
    phone = Phone(aiortc)
    try:
        offer = await phone.offer()
        answer = await asyncio.wait_for(lab.service.open(SESSION, offer, TOKEN, 30), 20)
        await phone.accept(answer)
        for _ in range(150):
            if lab.service.session_id is None:
                break
            await asyncio.sleep(0.1)

        assert lab.service.session_id is None
        assert lab.pc.calls == []
    finally:
        await close_quietly(phone)
        await lab.aclose()


async def test_a_peer_whose_address_cannot_be_read_is_dropped_not_trusted() -> None:
    # A conferência final falha FECHADA: se a biblioteca mudar e o par não puder ser lido, o canal
    # cai (o app segue pela nuvem) em vez de ficar aberto para um endereço que ninguém conferiu.
    closed: list[bool] = []
    peer = pc_direct_aiortc.AiortcPeer(
        PeerCallbacks(
            on_message=lambda channel, text: None,
            on_open=lambda: None,
            on_closed=lambda: closed.append(True),
        )
    )
    peer._pc = object()  # sem `sctp`: o caminho até o par nominado não existe

    assert peer._remote_is_lan() is False


async def test_the_peer_refuses_a_late_candidate_outside_the_local_network_before_the_library() -> (
    None
):
    reached: list[Any] = []

    class FakeConnection:
        async def addIceCandidate(self, candidate: Any) -> None:  # noqa: N802 - API da biblioteca
            reached.append(candidate)

    peer = pc_direct_aiortc.AiortcPeer(
        PeerCallbacks(on_message=lambda c, t: None, on_open=lambda: None, on_closed=lambda: None)
    )
    peer._pc = FakeConnection()

    await peer.add_candidate("candidate:1 1 udp 1 203.0.113.9 5000 typ srflx", "0", 0)
    await peer.add_candidate("candidate:2 1 tcp 1 192.168.1.9 9 typ host", "0", 0)
    await peer.add_candidate("candidate:3 1 udp 1 192.168.1.9 3478 typ relay", "0", 0)

    assert reached == []
