"""Porta do canal ADB da TV: lista de apps, abertura por pacote e digitação de texto ASCII.

O ADB faz o que o controle remoto (Remote v2) não faz: sabe quais apps a TV tem e abre um app pelo
nome do pacote. O adaptador usa o `adb` do próprio PC (o servidor dele é quem segura a conexão), um
comando por vez.

As mensagens dos erros são fixas e seguras para ir à tela do dono: nunca trazem caminho do
computador nem a saída crua do `adb`.
"""

from dataclasses import dataclass
from typing import Final, Protocol

from uniover_agent.ports.tv_channel import TvChannel, TvChannelError

ADB_UNAVAILABLE: Final = "adb_unavailable"
ADB_UNAUTHORIZED: Final = "adb_unauthorized"
ADB_UNREACHABLE: Final = "adb_unreachable"
ADB_TIMEOUT: Final = "adb_timeout"
ADB_FAILED: Final = "adb_failed"


class AdbError(TvChannelError):
    """Falha do canal ADB. `code` vai para a API e `message` para o dono."""

    code: str = ADB_FAILED

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AdbNotReady(AdbError):  # noqa: N818 - lê-se como estado, não como erro genérico
    """O canal não abriu, então o comando **nem chegou a ser executado** na TV.

    Quem tem outro caminho (digitar pelo Remote v2) pode usá-lo sem risco de repetir o efeito.
    """


class AdbUnavailable(AdbNotReady):
    """O `adb` não foi encontrado neste PC."""

    code = ADB_UNAVAILABLE


class AdbUnauthorized(AdbNotReady):
    """A TV ainda não autorizou este PC (aparece um aviso na tela da TV)."""

    code = ADB_UNAUTHORIZED


class AdbUnreachable(AdbNotReady):
    """A TV não responde pelo ADB (desligada, fora da rede, ADB desativado ou conexão derrubada)."""

    code = ADB_UNREACHABLE


class AdbTimeout(AdbError):  # noqa: N818
    """O comando estourou o tempo: não se sabe se a TV chegou a executá-lo."""

    code = ADB_TIMEOUT


class AdbCommandFailed(AdbError):  # noqa: N818
    """O `adb` respondeu, mas o comando não deu certo (app inexistente, por exemplo)."""

    code = ADB_FAILED


def is_adb_typable(text: str) -> bool:
    """Texto que o `input text` escreve fielmente: ASCII imprimível, sem `%`.

    `%` fica de fora porque `%s` vira espaço e o Android não tem como escrever um `%` literal
    seguido de `s`. Acentos e emoji o `input text` simplesmente descarta.
    """
    return bool(text) and all(" " <= char <= "~" and char != "%" for char in text)


@dataclass(frozen=True, slots=True)
class LaunchableApp:
    """Um app que a TV mostra para abrir: pacote e a atividade de entrada (`.Main` ou completa).

    `user_installed` é verdadeiro para o que o dono instalou (`pm list packages -3`), em oposição
    aos apps que já vêm com a TV.
    """

    package: str
    activity: str
    user_installed: bool = False


class TvAdb(TvChannel, Protocol):
    async def list_apps(self) -> list[LaunchableApp]:
        """Apps lançáveis: os da tela inicial da TV e, se não houver, os de celular.

        Um por pacote, na ordem em que a TV os devolve. Levanta `AdbError`.
        """
        ...

    async def launch_package(self, package: str, activity: str | None = None) -> None:
        """Abre o app. Sem `activity`, descobre a de entrada; sem achar, usa o lançador padrão.

        Levanta `ValueError` se o pacote ou a atividade não têm o formato do Android e `AdbError`
        se não deu certo.
        """
        ...

    async def input_text(self, text: str) -> None:
        """Digita no campo em foco (acrescenta ao que há lá).

        Só ASCII imprimível sem `%` (o `input text` do Android não tem como escrever `%` seguido
        de `s`). Levanta `ValueError` fora disso, e `AdbError` se não deu certo.
        """
        ...
