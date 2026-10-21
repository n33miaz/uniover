"""Porta do controle remoto da TV: teclas, links e o estado que a própria TV empurra."""

from collections.abc import Callable
from typing import Protocol

from uniover_agent.ports.tv_channel import TvChannel


class TvRemote(TvChannel, Protocol):
    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        """Aperta uma tecla do contrato (`HOME`, `VOLUME_UP`...).

        `direction`: `SHORT`, `START_LONG` ou `END_LONG`.

        Levanta `TvUnreachable` se o canal não está aberto.
        """
        ...

    async def launch_link(self, link: str) -> None:
        """Abre um link (deep link) na TV."""
        ...

    async def send_text(self, text: str) -> None:
        """Digita `text` no campo de texto em foco na TV: a TV **insere** o trecho (não substitui).

        Quem chama manda só o acréscimo; reenviar o campo inteiro duplicaria as letras. Texto vazio
        não é aceito (o protocolo não tem como limpar o campo por este canal: apagar é com a tecla
        `DEL`). Sem campo em foco a TV ignora o envio em silêncio.

        Levanta `TvUnreachable` se o canal não está aberto.
        """
        ...

    # Assinaturas do estado por empurrão. Os callbacks são síncronos e rodam no laço de eventos.
    def on_power(self, callback: Callable[[bool], None]) -> None:
        """Ligada (`True`) ou desligada (`False`), como a TV informa."""
        ...

    def on_app(self, callback: Callable[[str], None]) -> None:
        """Pacote do app em primeiro plano."""
        ...

    def on_volume(self, callback: Callable[[int], None]) -> None:
        """Volume em porcentagem (0 a 100)."""
        ...

    def on_available(self, callback: Callable[[bool], None]) -> None:
        """`False` quando o canal caiu sem o agente pedir; `True` quando voltou a aceitar teclas."""
        ...
