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


class TvCertificateRefused(TvNotPaired):
    """A TV recusou o certificado do UniOver na conexão TLS.

    Pode ser passageiro (a TV recusa por instantes ao subir), então o gerenciador só trata como
    "não pareada" depois de a recusa se repetir com intervalo; antes disso é falha de rede comum.
    Falta de arquivo de certificado continua sendo `TvNotPaired` simples: essa é definitiva.
    """


class TvPermissionNeeded(TvNotPaired):
    """A TV não reconhece mais o UniOver (permissão revogada ou vencida).

    Subclasse de `TvNotPaired` de propósito: repetir não adianta e, pior, cada tentativa faria a TV
    mostrar o aviso "Permitir" de novo sem ninguém ter pedido. Só um pedido explícito (a pessoa
    tocando em "Pedir Agora" no app) volta a falar com a TV nesse estado.
    """


class TvPairingFailed(TvChannelError):  # noqa: N818 - lê-se como fato
    """O pareamento pedido pelo app não terminou. `reason` é o código estável que a API repassa.

    A mensagem já é para a pessoa e nunca carrega o código de pareamento (nem o da TV, nem o
    texto cru da biblioteca).
    """

    def __init__(self, message: str, reason: str = "pair_failed") -> None:
        super().__init__(message)
        self.reason = reason


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
