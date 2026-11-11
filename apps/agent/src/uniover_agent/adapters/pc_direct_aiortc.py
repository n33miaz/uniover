"""Canal direto (WebRTC) com o `aiortc`: dois canais de dados, sem mídia e sem terceiros.

Carregado só na primeira oferta (importar o `aiortc` leva cerca de 1 s e não pode parar o laço de
eventos). `iceServers=[]`: nenhum STUN do Google. Só endereços da rede local, dos dois lados (ver
`pc_direct_network`): da oferta só entram candidatos privados, de enlace local ou ULA, e o que o
agente oferece na resposta são só os IPv4 privados e IPv6 ULA de interfaces físicas, sem o IPv6
global (o endereço público do PC), VPN, WSL nem Hyper-V. Os candidatos `.local` da oferta são
tirados antes de aplicá-la: o `aioice` não os resolve no Windows (espera 1 s e desiste), e a
conexão fecha mesmo assim, pelo endereço de onde o app manda os testes de conectividade, que é
conferido quando ela fecha: se não for da rede local, o canal é derrubado.
A impressão digital DTLS da oferta e da resposta passa pelo canal autenticado (a API): é ela que o
`aiortc` e o navegador conferem no aperto de mão, então quem está na rede e não a conhece não abre
o canal. O porto UDP é efêmero e fecha com a sessão.
"""

import asyncio
import contextlib
import importlib.util
import logging
from typing import Any, Final

from uniover_agent.adapters import pc_direct_network, pc_direct_stub_av
from uniover_agent.ports.pc_direct import (
    INPUT_CHANNEL,
    POINTER_CHANNEL,
    DirectPeer,
    DirectUnavailable,
    PeerCallbacks,
)

_log = logging.getLogger(__name__)

_CHANNELS: Final = (POINTER_CHANNEL, INPUT_CHANNEL)
_loaded: dict[str, Any] = {}


def aiortc_installed() -> bool:
    """A biblioteca está instalada (sem importá-la)."""
    return importlib.util.find_spec("aiortc") is not None


def _import_aiortc() -> Any:
    if importlib.util.find_spec("av") is None:
        pc_direct_stub_av.install()
    import aioice.ice  # noqa: PLC0415 - carregado sob demanda, junto com o aiortc
    import aiortc  # noqa: PLC0415 - carregado sob demanda (cerca de 1 s)

    # Os candidatos que o agente junta: só os da rede local (o padrão do `aioice` oferece tudo).
    aioice.ice.get_host_addresses = pc_direct_network.lan_host_addresses
    return aiortc


async def _load() -> Any:
    if "aiortc" not in _loaded:
        if not aiortc_installed():
            raise DirectUnavailable("aiortc não está instalado")
        _loaded["aiortc"] = await asyncio.to_thread(_import_aiortc)
    return _loaded["aiortc"]


def prepare_offer(sdp: str) -> str:
    """A oferta como o agente a aplica: só um canal de dados com impressão digital, e só candidatos
    da rede local (sem `.local`, sem endereço público, sem nome).

    `ValueError` se a oferta pede mídia ou não traz a impressão digital DTLS.
    """
    lines = sdp.splitlines()
    media = [line for line in lines if line.startswith("m=")]
    if not media or any(not line.startswith("m=application") for line in media):
        raise ValueError("a oferta precisa ser só de canal de dados")
    if not any(line.startswith("a=fingerprint:") for line in lines):
        raise ValueError("a oferta não traz a impressão digital DTLS")
    kept = pc_direct_network.filter_offer_candidates(lines)
    return "\r\n".join(kept) + "\r\n"


class AiortcPeer:
    """Um par WebRTC que atende a oferta do app (o agente nunca oferece)."""

    def __init__(self, callbacks: PeerCallbacks) -> None:
        self._callbacks = callbacks
        self._pc: Any = None
        self._channels: dict[str, Any] = {}
        self._opened: set[str] = set()
        self._closed = False

    async def accept_offer(self, sdp: str) -> str:
        aiortc = await _load()
        offer = prepare_offer(sdp)
        pc = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        self._pc = pc

        async def on_state() -> None:
            if pc.connectionState in ("failed", "closed"):
                self._signal_closed()
            elif pc.connectionState == "connected" and not self._remote_is_lan():
                _log.warning("canal direto derrubado: o par não está na rede local")
                self._signal_closed()

        pc.on("datachannel", self._adopt)
        pc.on("connectionstatechange", on_state)

        await pc.setRemoteDescription(aiortc.RTCSessionDescription(sdp=offer, type="offer"))
        await pc.setLocalDescription(await pc.createAnswer())
        return str(pc.localDescription.sdp)

    def _remote_is_lan(self) -> bool:
        """O endereço de onde o app de fato chegou (o par escolhido) é da rede local?

        Os candidatos da oferta já foram filtrados, mas o `aioice` aceita também o endereço de onde
        um
        teste de conectividade chega (o que fecha a conexão com `.local`); este é o conferido. Se a
        biblioteca mudar e o par não puder ser lido, a conferência FALHA FECHADA: o canal é
        derrubado (o app segue pela nuvem) em vez de ficar aberto para um endereço não conferido.
        """
        try:
            pair = self._pc.sctp.transport.transport._connection._nominated[1]
            return pc_direct_network.is_lan_address(str(pair.remote_addr[0]))
        except Exception:
            _log.warning("canal direto derrubado: não consegui conferir o endereço do par")
            return False

    def _adopt(self, channel: Any) -> None:
        label = str(channel.label)
        # Só os dois canais combinados, uma vez cada; o de entrada precisa ser ordenado e confiável.
        if label not in _CHANNELS or label in self._channels:
            channel.close()
            return
        if label == INPUT_CHANNEL and not channel.ordered:
            channel.close()
            return
        self._channels[label] = channel

        def on_message(message: Any) -> None:
            if isinstance(message, str):  # binário não é parte do protocolo
                self._callbacks.on_message(label, message)

        channel.on("message", on_message)
        channel.on("close", self._signal_closed)

        if channel.readyState == "open":
            self._mark_open(label)
        else:
            channel.on("open", lambda: self._mark_open(label))

    def _mark_open(self, label: str) -> None:
        self._opened.add(label)
        if self._opened.issuperset(_CHANNELS):
            self._callbacks.on_open()

    def _signal_closed(self) -> None:
        if not self._closed:
            self._closed = True
            self._callbacks.on_closed()

    async def add_candidate(self, candidate: str, mid: str | None, index: int | None) -> None:
        if self._pc is None or self._closed:
            return
        # Defesa em profundidade: o serviço já recusou o que não é da rede local, e a oferta foi
        # filtrada; aqui a regra vale de novo, porque é a última porta antes da biblioteca.
        if not pc_direct_network.candidate_is_lan(candidate):
            return
        from aiortc.sdp import candidate_from_sdp  # noqa: PLC0415 - só com a biblioteca carregada

        parsed = candidate_from_sdp(candidate.removeprefix("candidate:"))
        parsed.sdpMid = mid
        parsed.sdpMLineIndex = index
        await self._pc.addIceCandidate(parsed)

    def send(self, channel: str, text: str) -> bool:
        target = self._channels.get(channel)
        if target is None or target.readyState != "open":
            return False
        target.send(text)
        return True

    async def close(self) -> None:
        self._closed = True  # fechar por aqui não é uma queda a avisar
        pc, self._pc = self._pc, None
        if pc is not None:
            with contextlib.suppress(Exception):
                await pc.close()


def build_peer(callbacks: PeerCallbacks) -> DirectPeer:
    """A fábrica que a montagem entrega ao serviço."""
    return AiortcPeer(callbacks)
