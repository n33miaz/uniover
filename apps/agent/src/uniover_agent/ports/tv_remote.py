"""Compatibilidade de nome para o driver de TV usado pelo Android."""

from typing import Protocol

from uniover_agent.ports.tv_driver import TvDriver


class TvRemote(TvDriver, Protocol):
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
