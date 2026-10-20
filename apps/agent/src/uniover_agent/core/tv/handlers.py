"""Handlers dos comandos da TV: traduzem a mensagem validada em chamadas à sessão da TV."""

import asyncio
import logging
from typing import Final, Protocol
from urllib.parse import urlsplit

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.session import TvSessionError

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


class TvControl(Protocol):
    """O que os handlers pedem à sessão da TV (o `TvSessionManager` implementa)."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None: ...

    async def launch_link(self, link: str) -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def wake(self) -> None: ...


def _failed(command: Command, exc: TvSessionError) -> CommandResult:
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
            return _failed(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_text_handler(tv: TvControl) -> Handler:
    """`tv.text.v1`: o campo de texto em foco na TV passa a ter exatamente este texto.

    O app manda o texto completo a cada pausa de digitação, então cada mensagem **substitui** a
    anterior (nunca se acrescenta). As mensagens são atendidas uma a uma, na ordem de chegada, e
    se uma mais nova já chegou enquanto a anterior esperava a vez (a TV acordando, por exemplo),
    a antiga é descartada: só o último texto interessa e a TV não pisca por estados intermediários.

    Texto vazio não é enviado: o protocolo do controle remoto não limpa o campo. O contrato já o
    recusa, esta guarda só evita que um corpo fora do contrato chegue à biblioteca.
    """
    turn = asyncio.Lock()
    latest = 0

    async def handle(command: Command) -> CommandResult:
        nonlocal latest
        text = command.body.get("text")
        if not isinstance(text, str):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'text' ausente")
        if not text:
            _log.info("texto vazio ignorado: o controle remoto não consegue limpar o campo")
            return CommandResult(command.id, ResultStatus.OK)
        latest += 1
        mine = latest
        async with turn:
            if mine != latest:
                # Já existe um texto mais novo na fila; ele é quem vai para a TV.
                return CommandResult(command.id, ResultStatus.OK)
            try:
                await tv.send_text(text)
            except TvSessionError as exc:
                return _failed(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_wake_handler(tv: TvControl) -> Handler:
    """`tv.wake.v1`: o app abriu, então aquece a sessão antes do primeiro toque."""

    async def handle(command: Command) -> CommandResult:
        try:
            await tv.wake()
        except TvSessionError as exc:
            return _failed(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle


def tv_app_launch_handler(
    tv: TvControl, *, allowed_schemes: frozenset[str] = DEFAULT_LINK_SCHEMES
) -> Handler:
    """`tv.app.launch.v1`: só `kind=link` aqui; abrir por pacote exige o canal ADB."""

    async def handle(command: Command) -> CommandResult:
        target = command.body.get("target")
        if not isinstance(target, dict):
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'target' ausente")
        kind, value = target.get("kind"), target.get("value")
        if kind == "package":
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "abrir app por pacote precisa do canal ADB, que não está habilitado",
                UNSUPPORTED,
            )
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
            return _failed(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle
