"""Comandos do PC que devolvem dados: "Tocando agora" e área de transferência.

`pc.media.query.v1` e `pc.clipboard.query.v1` pedem uma leitura; o agente a manda em outra mensagem
(`pc.media.state.v1`, `pc.clipboard.v1`, com o `correlationId` do pedido) e só depois responde o
`command.result.v1`: quando a API vê o resultado, o dado já chegou. `pc.clipboard.set.v1` troca o
texto da área de transferência do PC.

O que passa por aqui é conteúdo da pessoa (o que ela ouve, o que copiou): nunca vai para o
registro, nem em depuração. Só a ação (ler, escrever) e o tamanho, quando muito.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports import Sender, TransportError
from uniover_agent.ports.pc import PcUnsupported
from uniover_agent.ports.pc_media import (
    MAX_CLIPBOARD_TEXT,
    NowPlaying,
    PcClipboard,
    PcMediaSession,
)

_log = logging.getLogger(__name__)

# Declaradas no `hello` só depois de a API listá-las em `features` (uma API anterior recusaria o
# tipo).
PC_MEDIA_STATE_CAPABILITY: Final = "pc.media.state.v1"
PC_CLIPBOARD_CAPABILITY: Final = "pc.clipboard.v1"

# O app pergunta o que toca a cada poucos segundos enquanto a tela está aberta; uma leitura custa um
# processo do sistema, então a anterior vale por este tempo (várias abas, vários aparelhos).
MEDIA_CACHE_SECONDS: Final = 2.0


def _failure(command: Command, exc: Exception) -> CommandResult:
    if isinstance(exc, PcUnsupported):
        return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "unsupported")
    if isinstance(exc, ValueError):
        return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "invalid_message")
    return CommandResult(command.id, ResultStatus.FAILED, str(exc), "failed")


def pc_media_query_handler(
    session: PcMediaSession,
    sender: Sender,
    envelopes: EnvelopeFactory,
    *,
    monotonic: Callable[[], float] = time.monotonic,
    cache_seconds: float = MEDIA_CACHE_SECONDS,
) -> Handler:
    """`pc.media.query.v1`: lê a sessão de mídia e a manda em `pc.media.state.v1`."""

    cached: tuple[float, NowPlaying] | None = None

    async def run(command: Command) -> CommandResult:
        nonlocal cached
        try:
            now = monotonic()
            if cached is not None and now - cached[0] < cache_seconds:
                playing = cached[1]
            else:
                # O processo do sistema roda em outra thread: o agente não para para ler a mídia.
                playing = await asyncio.to_thread(session.read)
                cached = (monotonic(), playing)
            await sender.send(envelopes.pc_media_state(playing, command.id))
        except (PcUnsupported, ValueError, OSError, TransportError) as exc:
            _log.debug("não foi possível ler o Tocando agora (%s)", type(exc).__name__)
            return _failure(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return run


def pc_clipboard_query_handler(
    clipboard: PcClipboard, sender: Sender, envelopes: EnvelopeFactory
) -> Handler:
    """`pc.clipboard.query.v1`: lê o texto da área de transferência e o manda em
    `pc.clipboard.v1`."""

    async def run(command: Command) -> CommandResult:
        try:
            text = await asyncio.to_thread(clipboard.read)
            await sender.send(envelopes.pc_clipboard(text, command.id))
        except (PcUnsupported, ValueError, OSError, TransportError) as exc:
            _log.debug("não foi possível ler a área de transferência (%s)", type(exc).__name__)
            return _failure(command, exc)
        _log.info("área de transferência do PC lida a pedido do app")
        return CommandResult(command.id, ResultStatus.OK)

    return run


def pc_clipboard_set_handler(clipboard: PcClipboard) -> Handler:
    """`pc.clipboard.set.v1`: troca o texto da área de transferência do PC pelo que o app mandou."""

    async def run(command: Command) -> CommandResult:
        text = command.body.get("text")
        # O contrato já limita o texto; isto só protege a área de transferência de um erro nosso.
        if not isinstance(text, str) or not text or len(text) > MAX_CLIPBOARD_TEXT:
            return CommandResult(
                command.id, ResultStatus.REJECTED, "texto fora do contrato", "invalid_message"
            )
        try:
            await asyncio.to_thread(clipboard.write, text)
        except (PcUnsupported, ValueError, OSError) as exc:
            _log.debug(
                "não foi possível escrever na área de transferência (%s)", type(exc).__name__
            )
            return _failure(command, exc)
        _log.info("área de transferência do PC trocada a pedido do app")
        return CommandResult(command.id, ResultStatus.OK)

    return run
