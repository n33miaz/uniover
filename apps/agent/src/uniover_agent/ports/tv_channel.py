"""Porta de um canal de controle da TV (Remote v2 agora, ADB depois).

O gerenciador de sessão só precisa disto de qualquer canal: abrir, fechar e saber se está aberto.
"""

from typing import Protocol


class TvChannelError(Exception):
    """Falha de um canal da TV; a mensagem é segura para log (nunca traz certificado ou chave)."""


class TvUnreachable(TvChannelError):  # noqa: N818 - lê-se como fato, não como erro genérico
    """A TV não respondeu: porta fechada, tempo esgotado ou conexão derrubada.

    É o sinal de que o serviço do controle remoto pode ter morrido (as portas 6466/6467 fecham).
    """


class TvPortClosed(TvUnreachable):
    """A TV está na rede mas **recusou** a conexão: o serviço do controle remoto morreu.

    Difere de `TvUnreachable` simples (sem resposta nenhuma), que é o que se vê com a TV em standby,
    sem interface de rede. Só este caso pede reparo do serviço.
    """


class TvNotPaired(TvChannelError):  # noqa: N818
    """Falta o par certificado/chave ou a TV o recusou: repetir não adianta, é preciso parear."""


class TvChannel(Protocol):
    @property
    def connected(self) -> bool: ...

    async def connect(self) -> None:
        """Abre o canal; com sessão anterior ainda aberta, a refaz do zero.

        Levanta `TvUnreachable` ou `TvNotPaired`.
        """
        ...

    async def disconnect(self) -> None:
        """Fecha o canal sem erro, mesmo que já esteja fechado."""
        ...
