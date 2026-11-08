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
from typing import Any

import pytest

from uniover_agent.adapters import pc_direct_aiortc, pc_direct_stub_av
from uniover_agent.adapters.pc_direct_aiortc import (
    aiortc_installed,
    build_peer,
    prepare_offer,
)

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
    def addresses(use_ipv4: bool, use_ipv6: bool) -> list[str]:
        return ["127.0.0.1"]

    monkeypatch.setattr("aioice.ice.get_host_addresses", addresses)


class Phone:
    """O celular: um `aiortc` com os dois canais de dados, como o app os abre."""

    def __init__(self, aiortc: Any) -> None:
        self.connection = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        self.pointer = self.connection.createDataChannel("pointer", ordered=False, maxRetransmits=0)
        self.input = self.connection.createDataChannel("input", ordered=True)
        self.inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.opened = asyncio.Event()
        self.aiortc = aiortc
        self.input.on("message", lambda text: self.inbox.put_nowait(json.loads(text)))
        self.pointer.on("open", self._check)
        self.input.on("open", self._check)

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
        assert await phone.next() == {"k": "ready"}

        phone.pointer.send(json.dumps({"k": "ptr", "s": 1, "x": 12, "y": -4, "w": 0, "h": 0}))
        click = {
            "k": "cmd",
            "i": "c1",
            "t": "pc.click.v1",
            "b": {"button": "LEFT", "action": "DOWN"},
            "ts": 0,
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
