"""Porta do canal ADB da TV: lista de apps, abertura por pacote e digitação de texto ASCII.

O ADB faz o que o controle remoto (Remote v2) não faz: sabe quais apps a TV tem e abre um app pelo
nome do pacote. O adaptador usa o `adb` do próprio PC (o servidor dele é quem segura a conexão), um
comando por vez.

As mensagens dos erros são fixas e seguras para ir à tela do dono: nunca trazem caminho do
computador nem a saída crua do `adb`.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Final, Protocol

from uniover_agent.ports.tv_channel import TvChannel, TvChannelError

ADB_UNAVAILABLE: Final = "adb_unavailable"
ADB_UNAUTHORIZED: Final = "adb_unauthorized"
ADB_UNREACHABLE: Final = "adb_unreachable"
ADB_IDLE: Final = "adb_idle"
ADB_IDENTITY: Final = "adb_identity"
ADB_TIMEOUT: Final = "adb_timeout"
ADB_FAILED: Final = "adb_failed"

# Só um pedido explícito da pessoa (um botão do app) pode abrir uma conexão nova com uma TV que
# ainda não deu a permissão do ADB: cada conexão assim faz a TV mostrar o aviso "Permitir depuração
# USB". O que o agente faz sozinho (partida, lista diária, limpeza, ícones, vigia) nunca a ergue.
# A marca guarda a **tarefa** que a ergueu: uma tarefa filha (`create_task` copia o contexto) não
# herda o direito, então nada que o pedido deixe rodando em segundo plano abre o aviso depois.
_log = logging.getLogger(__name__)


@dataclass(slots=True, eq=False)
class UserRequest:
    """O pedido da pessoa em andamento: a tarefa que o recebeu e o que fazer quando ele termina.

    O adaptador registra aqui o que precisa ser desfeito no fim (por exemplo, `adb disconnect` de
    uma conexão que não terminou provada: o servidor do `adb` religa sozinho conexões TCP feitas
    com `adb connect`, e cada religação seria um aviso novo na TV).
    """

    task: asyncio.Task[object] | None
    cleanups: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    def on_finish(self, cleanup: Callable[[], Awaitable[None]]) -> None:
        if cleanup not in self.cleanups:
            self.cleanups.append(cleanup)

    async def finish(self) -> None:
        """Roda o que o pedido deixou para o fim (uma vez); falha de um não impede os outros."""
        pending, self.cleanups = self.cleanups, []
        for cleanup in pending:
            try:
                await cleanup()
            except Exception:
                _log.exception("falha ao encerrar o pedido do ADB")


ADB_USER_INITIATED: Final[ContextVar[UserRequest | None]] = ContextVar(
    "adb_user_initiated", default=None
)


def current_user_request() -> UserRequest | None:
    """O pedido da pessoa desta tarefa, ou `None` (tarefa filha ou caminho automático)."""
    request = ADB_USER_INITIATED.get()
    return request if request is not None and request.task is asyncio.current_task() else None


def is_user_initiated() -> bool:
    """A tarefa de agora é a que o pedido da pessoa marcou?"""
    return current_user_request() is not None


@contextmanager
def user_initiated_adb() -> Iterator[UserRequest]:
    """Dentro do bloco, o ADB pode pedir a permissão à TV (a pessoa pediu isto agora).

    Quem roda um pedido inteiro (o handler do app) deve chamar `await request.finish()` no fim.
    """
    request = UserRequest(asyncio.current_task())
    token = ADB_USER_INITIATED.set(request)
    try:
        yield request
    finally:
        ADB_USER_INITIATED.reset(token)


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

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


class AdbUnauthorized(AdbNotReady):
    """A TV ainda não autorizou este PC (aparece um aviso na tela da TV)."""

    code = ADB_UNAUTHORIZED


class AdbIdle(AdbNotReady):
    """O ADB não abriu conexão nova por regra, não por defeito: ninguém tocou na tela da TV agora.

    Não é recusa da TV (ela pode estar com a permissão dada): é o agente que se recusa a abrir um
    aviso sem ninguém por perto. Um toque no app (ou o sinal de presença) libera.
    """

    code = ADB_IDLE


class AdbIdentityUnconfirmed(AdbNotReady):
    """O ADB não abriu: não deu para confirmar qual aparelho responde (a ARP não mostra o MAC).

    Diferente de `AdbIdle`: aqui alguém pode estar usando a TV pelo app, e a causa é a rede (VPN,
    outra sub-rede), não a falta de uso. O pedido da pessoa (Atualizar lista) não depende do MAC.
    """

    code = ADB_IDENTITY


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
    """Texto que o `input text` escreve fielmente: ASCII imprimível (inclusive `%`).

    O `input text` do Android (`Input.sendText`, conferido na fonte do Android 11, o da TCL) só
    interpreta `%s`, que vira espaço. Qualquer outro `%` é escrito como está, então `%ab` vai
    inteiro. O que ele não escreve é um `%` literal logo seguido de um `s` literal: esse par é
    separado em dois comandos por `adb_text_groups`. Acentos e emoji o `input text` descarta.
    """
    return bool(text) and all(" " <= char <= "~" for char in text)


def adb_text_groups(text: str, max_chars: int = 200) -> list[str]:
    """Divide um texto digitável em grupos, cada um um comando `input text` só.

    Um grupo termina onde o próximo caractere seria o `s` de um `%` literal (o par `%s` viraria um
    espaço dentro do mesmo comando) ou quando chega a `max_chars`. Os grupos, juntos e na ordem,
    dão o texto de volta. Levanta `ValueError` se o texto não for digitável pelo ADB.
    """
    if not is_adb_typable(text):
        raise ValueError("texto fora do que o ADB digita com fidelidade")
    if max_chars < 1:
        raise ValueError("o grupo precisa de ao menos um caractere")
    groups: list[str] = []
    start = 0
    for index in range(1, len(text)):
        if (text[index - 1] == "%" and text[index] == "s") or index - start >= max_chars:
            groups.append(text[start:index])
            start = index
    groups.append(text[start:])
    return groups


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

        Só ASCII imprimível, e sem um `%` literal seguido de `s` (o `input text` do Android lê o par
        como espaço: quem chama divide com `adb_text_groups`). Levanta `ValueError` fora disso, e
        `AdbError` se não deu certo.
        """
        ...
