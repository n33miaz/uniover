"""Porta do canal de mensagens com a API: o núcleo não sabe qual transporte está por baixo."""

from collections.abc import AsyncIterator
from typing import Any, Protocol


class TransportError(Exception):
    """Falha transitória (rede, servidor fora do ar, conexão perdida): vale reconectar."""


class CredentialRejected(TransportError):  # noqa: N818 - lê-se como fato, não como erro genérico
    """O servidor recusou a credencial (401/403 ou revogação): reconectar não adianta."""


class ConnectionReplaced(TransportError):  # noqa: N818
    """Outra instância do mesmo agente assumiu a conexão (um dono por conexão)."""


class HandoverRequested(TransportError):  # noqa: N818
    """Uma execução nova assumiu; esta deve encerrar de modo limpo e sem reconectar."""


class HandoverUnsupported(TransportError):  # noqa: N818
    """A API não tem a rota da candidata da passagem (é uma versão anterior): a passagem sem queda
    não existe com ela."""


class ServerRestarting(TransportError):  # noqa: N818
    """O servidor avisou que reinicia (deploy, troca de instância): volta-se logo, sem espera."""


class ServerRestartNow(ServerRestarting):
    """A API que vai parar mandou reconectar já (fechamento 4411): volta de 0,2 a 0,5 s."""


class Transport(Protocol):
    """Canal de envelopes com a API; WebSocket hoje, MQTT depois, mesmo envelope."""

    @property
    def connected(self) -> bool: ...

    async def connect(self) -> None:
        """Abre o canal. Levanta `CredentialRejected` ou `TransportError`."""
        ...

    async def send(self, message: dict[str, Any]) -> None:
        """Envia um envelope já montado e validado."""
        ...

    def incoming(self) -> AsyncIterator[str | bytes]:
        """Fluxo de mensagens CRUAS (texto JSON); a validação é do núcleo, não do transporte.

        Termina quando o canal fecha sem erro; levanta `TransportError` (ou subclasse) quando cai.
        """
        ...

    async def close(self) -> None: ...


class Sender(Protocol):
    """O que quem só responde precisa do transporte: enviar um envelope já montado e validado.

    A faixa do PC roda noutro laço que o do transporte e recebe um `Sender` que leva o envio até
    lá (ver `adapters/pc_input_thread.py`).
    """

    async def send(self, message: dict[str, Any]) -> None: ...
