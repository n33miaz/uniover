"""Portas do "Tocando agora" e da área de transferência do PC.

O que passa por aqui é conteúdo da pessoa (o título do que ela ouve, o texto que copiou): as
implementações nunca o registram, e o núcleo só o repassa à API, que o guarda em memória.
"""

from dataclasses import dataclass
from typing import Final, Protocol

# Os estados do `pc.media.state.v1`: tocando, pausado, parado (há uma sessão de mídia que não toca)
# e nenhum (o Windows não tem sessão de mídia nenhuma).
STATUS_PLAYING: Final = "playing"
STATUS_PAUSED: Final = "paused"
STATUS_STOPPED: Final = "stopped"
STATUS_NONE: Final = "none"

# Tamanhos do contrato (`pc.media.state.v1`): quem lê corta nestes limites.
MAX_MEDIA_TEXT: Final = 200
# O maior texto que atravessa a área de transferência (`pc.clipboard.*`), em caracteres.
MAX_CLIPBOARD_TEXT: Final = 5000


@dataclass(frozen=True, slots=True)
class NowPlaying:
    """O que o Windows diz estar tocando. `title`, `artist` e `app` vêm vazios quando não há
    sessão."""

    status: str
    title: str = ""
    artist: str = ""
    app: str = ""


class PcMediaSession(Protocol):
    """A sessão de mídia atual do Windows (a que a tela de bloqueio e as teclas de mídia
    mostram)."""

    def read(self) -> NowPlaying:
        """Lê o que toca agora. Só leitura: nunca aperta tecla nem muda a reprodução."""
        ...


class PcClipboard(Protocol):
    """O texto da área de transferência do PC. Outros formatos (imagem, arquivos) não passam."""

    def read(self) -> str:
        """O texto copiado, até `MAX_CLIPBOARD_TEXT` caracteres; vazio sem texto na área."""
        ...

    def write(self, text: str) -> None:
        """Troca o conteúdo da área de transferência por este texto."""
        ...
