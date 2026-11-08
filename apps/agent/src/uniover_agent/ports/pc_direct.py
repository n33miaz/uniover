"""Porta do canal direto (WebRTC) entre o app e o PC.

O núcleo decide quem pode abrir o canal, o que cada mensagem vale e quando ele fecha; quem fala
WebRTC (a biblioteca, os candidatos de rede, a impressão digital DTLS) é o adaptador.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

# Os dois canais de dados que o app abre: o ponteiro (não ordenado, sem retransmissão: o que se
# perde é coberto pelo total acumulado da próxima mensagem) e a entrada (ordenado e confiável:
# cliques, teclas, texto e mídia, mais o `auth` e as respostas).
POINTER_CHANNEL = "pointer"
INPUT_CHANNEL = "input"


class DirectUnavailable(Exception):  # noqa: N818 - o nome diz o que aconteceu
    """O canal direto não pode ser aberto neste PC (biblioteca ausente, oferta recusada)."""


@dataclass(frozen=True, slots=True)
class PeerCallbacks:
    """O que o adaptador avisa ao núcleo, sempre no laço de eventos do agente."""

    # (canal, texto): só mensagens de texto chegam; binário é descartado pelo adaptador.
    on_message: Callable[[str, str], None]
    # Os dois canais abriram.
    on_open: Callable[[], None]
    # O par acabou (queda, falha do teste de consentimento do ICE, o app fechou).
    on_closed: Callable[[], None]


class DirectPeer(Protocol):
    async def accept_offer(self, sdp: str) -> str:
        """Aplica a oferta do app e devolve a resposta (com a impressão digital DTLS do agente)."""
        ...

    async def add_candidate(self, candidate: str, mid: str | None, index: int | None) -> None: ...

    def send(self, channel: str, text: str) -> bool:
        """Envia um texto no canal; `False` se ele não está aberto."""
        ...

    async def close(self) -> None: ...


DirectPeerFactory = Callable[[PeerCallbacks], DirectPeer]
