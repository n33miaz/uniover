"""Handlers dos comandos da TV: traduzem a mensagem validada em chamadas à sessão da TV."""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Final, Protocol
from urllib.parse import urlsplit

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.session import PowerOffResult, TvSessionError
from uniover_agent.core.tv.text_edit import TextReconciler

_log = logging.getLogger(__name__)

# Esquemas de link que podem ser abertos na TV. `intent://` e afins ficam de fora de propósito: o
# contrato só fixa o formato do link, quem decide o que pode ser aberto é este agente.
DEFAULT_LINK_SCHEMES: Final = frozenset({"https", "http", "market", "vnd.youtube"})

# Declarada no `agent.hello.v1`: a API só manda `tv.power.off.v1` a quem a tem.
POWER_OFF_CAPABILITY: Final = "tv.power.off.v1"

KEY_BLOCKED: Final = "key_blocked"
UNSUPPORTED: Final = "unsupported"
LINK_SCHEME_BLOCKED: Final = "link_scheme_not_allowed"
INVALID_TARGET: Final = "invalid_target"


class PackageLauncher(Protocol):
    """Abre um app pelo nome do pacote (o canal ADB; sem ele o pedido é recusado)."""

    async def launch_package(self, package: str) -> None: ...


class TvControl(Protocol):
    """O que os handlers pedem à sessão da TV (o `TvSessionManager` implementa)."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None: ...

    async def launch_link(self, link: str) -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def wake(self) -> None: ...

    async def power_off(self) -> PowerOffResult: ...


def failed_result(command: Command, exc: TvSessionError) -> CommandResult:
    return CommandResult(command.id, ResultStatus.FAILED, exc.message, exc.code)


def unsupported_handler(message: str) -> Handler:
    """Recusa um comando conhecido que este tipo de TV não consegue executar."""

    async def handle(command: Command) -> CommandResult:
        return CommandResult(command.id, ResultStatus.REJECTED, message, UNSUPPORTED)

    return handle


def tv_key_handler(tv: TvControl, *, blocked_keys: frozenset[str] = frozenset()) -> Handler:
    """Trata `tv.key.v1` e `tv.key.v2` (a direção só existe na v2; o padrão é `SHORT`).

    Nenhuma tecla é recusada por padrão, nem `POWER`: quem decide o desligamento é o app (a folha
    de confirmação) e a API (a rota própria, que a rota genérica de teclas recusa). Quem montar o
    agente pode ainda bloquear teclas por `blocked_keys`; elas voltam como `KEY_BLOCKED` sem sequer
    abrir a sessão com a TV.
    """

    async def handle(command: Command) -> CommandResult:
        key = command.body.get("key")
        if not isinstance(key, str) or not key:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'key' ausente")
        if key in blocked_keys:
            _log.warning("tecla %s recusada: bloqueada neste agente", key)
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                f"a tecla {key} está bloqueada neste agente",
                KEY_BLOCKED,
            )
        direction = command.body.get("direction") or "SHORT"
        try:
            await tv.send_key(key, str(direction))
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_text_handler(
    tv: TvControl,
    *,
    reconciler: TextReconciler | None = None,
    monotonic: Callable[[], float] = time.monotonic,
) -> Handler:
    """`tv.text.v1`: o campo de texto em foco na TV passa a ter este texto.

    O app manda o texto completo a cada pausa de digitação. O agente não reenvia o campo inteiro (o
    controle remoto insere, então duplicava letras): o `TextReconciler` compara com o que ele
    mesmo digitou, apaga o excedente com `DEL` e digita só o acréscimo. Texto vazio apaga tudo o
    que o agente digitou.

    As mensagens são atendidas uma a uma, na ordem de chegada, e se uma mais nova já chegou enquanto
    a anterior esperava a vez (a TV acordando, por exemplo), a antiga é descartada: o diff é sempre
    contra o último texto pedido, então pular um estado intermediário é seguro. Quanto cada
    mensagem esperou a vez entra no resumo do log (nunca o texto).
    """
    editor = reconciler or TextReconciler(tv)
    turn = asyncio.Lock()
    latest = 0

    async def handle(command: Command) -> CommandResult:
        nonlocal latest
        text = command.body.get("text")
        if not isinstance(text, str):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'text' ausente")
        arrived = monotonic()
        latest += 1
        mine = latest
        async with turn:
            queued = monotonic() - arrived
            if mine != latest:
                # Já existe um texto mais novo na fila; ele é quem vai para a TV.
                _log.info("texto descartado: chegou um mais novo | ms vez=%d", round(queued * 1000))
                return CommandResult(command.id, ResultStatus.OK)
            try:
                await editor.set_text(text, queued=queued)
            except TvSessionError as exc:
                return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_wake_handler(tv: TvControl) -> Handler:
    """`tv.wake.v1`: o app abriu, então aquece a sessão antes do primeiro toque."""

    async def handle(command: Command) -> CommandResult:
        try:
            await tv.wake()
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


_POWER_OFF_MESSAGES: Final = {
    PowerOffResult.ALREADY_OFF: "a TV já estava desligada; nenhuma tecla foi enviada",
    PowerOffResult.UNCERTAIN: "não deu para confirmar o estado da TV; a tecla não foi repetida",
    PowerOffResult.OFFLINE: "a TV não respondeu ao controle; nenhuma tecla foi enviada",
    PowerOffResult.FAILED: "o agente não conseguiu desligar a TV",
}


def tv_power_off_handler(tv: TvControl) -> Handler:
    """`tv.power.off.v1`: desliga só com a TV lida como ligada e nunca a liga.

    O resultado é `ok` só quando o desligamento foi confirmado; nos demais casos o código estável
    (`already_off`, `uncertain`, `offline`, `failed`) diz à API o que dizer ao dono.
    """

    async def handle(command: Command) -> CommandResult:
        result = await tv.power_off()
        if result is PowerOffResult.OFF:
            return CommandResult(command.id, ResultStatus.OK)
        return CommandResult(
            command.id, ResultStatus.FAILED, _POWER_OFF_MESSAGES[result], result.value
        )

    return handle


async def _launch_package(
    command: Command, packages: PackageLauncher, value: object
) -> CommandResult:
    if not isinstance(value, str) or not value:
        return CommandResult(command.id, ResultStatus.REJECTED, "alvo inválido")
    try:
        await packages.launch_package(value)
    except ValueError:
        return CommandResult(
            command.id, ResultStatus.REJECTED, "nome de pacote inválido", INVALID_TARGET
        )
    except TvSessionError as exc:
        return failed_result(command, exc)
    return CommandResult(command.id, ResultStatus.OK)


async def _launch_link(
    command: Command, tv: TvControl, allowed_schemes: frozenset[str], kind: object, value: object
) -> CommandResult:
    if kind != "link" or not isinstance(value, str) or not value:
        return CommandResult(command.id, ResultStatus.REJECTED, "alvo inválido")
    scheme = urlsplit(value).scheme.lower()
    if scheme not in allowed_schemes:
        return CommandResult(
            command.id,
            ResultStatus.REJECTED,
            f"esquema de link não permitido: {scheme or '(nenhum)'}",
            LINK_SCHEME_BLOCKED,
        )
    try:
        await tv.launch_link(value)
    except TvSessionError as exc:
        return failed_result(command, exc)
    return CommandResult(command.id, ResultStatus.OK)


def tv_app_launch_handler(
    tv: TvControl,
    *,
    allowed_schemes: frozenset[str] = DEFAULT_LINK_SCHEMES,
    packages: PackageLauncher | None = None,
    links_supported: bool = True,
) -> Handler:
    """`tv.app.launch.v1`: link pelo controle remoto; pacote pelo canal ADB (`packages`).

    Sem o canal ADB, abrir por pacote é recusado com `unsupported`. Drivers sem abertura de link
    passam `links_supported=False`, para que o app esconda a ação em vez de tentar um protocolo que
    a TV não oferece.
    """

    async def handle(command: Command) -> CommandResult:
        target = command.body.get("target")
        if not isinstance(target, dict):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'target' ausente")
        kind, value = target.get("kind"), target.get("value")
        if kind == "package" and packages is not None:
            return await _launch_package(command, packages, value)
        if kind == "package":
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "abrir app por pacote precisa do canal ADB, que não está habilitado",
                UNSUPPORTED,
            )
        if kind == "link" and not links_supported:
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "a TV não suporta abrir links por este canal",
                UNSUPPORTED,
            )
        return await _launch_link(command, tv, allowed_schemes, kind, value)

    return handle
