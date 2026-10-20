"""Handlers dos comandos da TV: traduzem a mensagem validada em chamadas à sessão da TV."""

import asyncio
import logging
from typing import Final, Protocol
from urllib.parse import urlsplit

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.core.tv.text_edit import TextReconciler

_log = logging.getLogger(__name__)

# Teclas que desligam a TV. Sem emissor infravermelho ela não volta do standby e não tem botão
# físico: o desligamento só deve existir com confirmação forte, e até lá o agente o recusa.
POWER_KEYS: Final = frozenset({"POWER"})
# Esquemas de link que podem ser abertos na TV. `intent://` e afins ficam de fora de propósito: o
# contrato só fixa o formato do link, quem decide o que pode ser aberto é este agente.
DEFAULT_LINK_SCHEMES: Final = frozenset({"https", "http", "market", "vnd.youtube"})

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


def failed_result(command: Command, exc: TvSessionError) -> CommandResult:
    return CommandResult(command.id, ResultStatus.FAILED, exc.message, exc.code)


def tv_key_handler(tv: TvControl, *, blocked_keys: frozenset[str] = POWER_KEYS) -> Handler:
    """Trata `tv.key.v1` e `tv.key.v2` (a direção só existe na v2; o padrão é `SHORT`)."""

    async def handle(command: Command) -> CommandResult:
        key = command.body.get("key")
        if not isinstance(key, str) or not key:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'key' ausente")
        if key in blocked_keys:
            _log.warning("tecla %s recusada: desligar a TV não está habilitado", key)
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "desligar a TV não está habilitado neste agente",
                KEY_BLOCKED,
            )
        direction = command.body.get("direction") or "SHORT"
        try:
            await tv.send_key(key, str(direction))
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_text_handler(tv: TvControl, *, reconciler: TextReconciler | None = None) -> Handler:
    """`tv.text.v1`: o campo de texto em foco na TV passa a ter este texto.

    O app manda o texto completo a cada pausa de digitação. O agente não reenvia o campo inteiro (o
    controle remoto insere, então duplicava letras): o `TextReconciler` compara com o que ele
    mesmo digitou, apaga o excedente com `DEL` e digita só o acréscimo. Texto vazio apaga tudo o
    que o agente digitou.

    As mensagens são atendidas uma a uma, na ordem de chegada, e se uma mais nova já chegou enquanto
    a anterior esperava a vez (a TV acordando, por exemplo), a antiga é descartada: o diff é sempre
    contra o último texto pedido, então pular um estado intermediário é seguro.
    """
    editor = reconciler or TextReconciler(tv)
    turn = asyncio.Lock()
    latest = 0

    async def handle(command: Command) -> CommandResult:
        nonlocal latest
        text = command.body.get("text")
        if not isinstance(text, str):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'text' ausente")
        latest += 1
        mine = latest
        async with turn:
            if mine != latest:
                # Já existe um texto mais novo na fila; ele é quem vai para a TV.
                return CommandResult(command.id, ResultStatus.OK)
            try:
                await editor.set_text(text)
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
) -> Handler:
    """`tv.app.launch.v1`: link pelo controle remoto; pacote pelo canal ADB (`packages`).

    Sem o canal ADB, abrir por pacote é recusado com `unsupported`.
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
        return await _launch_link(command, tv, allowed_schemes, kind, value)

    return handle
