"""Volume absoluto do PC: o comando `pc.volume.v1` e o aviso do nível (`pc.volume.state.v1`).

O nível sobe à API (que o devolve no estado do PC) em três momentos: ao conectar e quando a API
passa a listar a capacidade, logo depois de um comando que muda o volume (`pc.volume.v1` e as
teclas de volume e de mudo de `pc.media.v1`), e numa leitura periódica que só avisa se o valor
mudou (o teclado do próprio PC também mexe no volume). Nada é enviado antes de a API listar a
capacidade (`enabled`): uma API anterior recusaria o tipo de mensagem.
"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports import Clock, Transport, TransportError
from uniover_agent.ports.pc import PcAudio, PcUnsupported, VolumeState

_log = logging.getLogger(__name__)

# De quanto em quanto tempo o nível é relido para pegar o que mudou por fora (o teclado do PC).
WATCH_SECONDS: Final = 5.0
# O Windows aplica a tecla de volume depois de o `SendInput` voltar: ler antes veria o de antes.
SETTLE_SECONDS: Final = 0.2

# O maior nível do contrato (`pc.volume.v1`).
MAX_VOLUME_LEVEL: Final = 100
# As teclas de `pc.media.v1` que mudam o volume.
VOLUME_MEDIA_ACTIONS: Final = frozenset({"VOLUME_UP", "VOLUME_DOWN", "MUTE"})


def pc_volume_handler(audio: PcAudio, *, changed: Callable[[], None] | None = None) -> Handler:
    """`pc.volume.v1`: define o nível (0 a 100) e/ou liga e desliga o mudo, nesta ordem.

    `changed` é avisado depois de o sistema aceitar a mudança (o aviso do nível sai atrás dela).
    """

    async def run(command: Command) -> CommandResult:
        body = command.body
        level = body.get("level")
        muted = body.get("muted")
        # O contrato pede pelo menos um dos dois (o modelo gerado não impõe o "ou"): um pedido vazio
        # não faz nada e é recusado, em vez de responder "feito".
        if level is None and muted is None:
            return CommandResult(
                command.id, ResultStatus.REJECTED, "volume sem nada a fazer", "invalid_message"
            )
        # O contrato limita o nível a inteiros de 0 a 100 e o mudo a verdadeiro ou falso: isto só
        # protege o sistema de um erro nosso. Nada é aplicado se um dos dois está fora.
        if (
            level is not None
            and (
                isinstance(level, bool)
                or not isinstance(level, int)
                or not 0 <= level <= MAX_VOLUME_LEVEL
            )
        ) or (muted is not None and not isinstance(muted, bool)):
            return CommandResult(
                command.id, ResultStatus.REJECTED, "volume fora do contrato", "invalid_message"
            )
        try:
            if level is not None:
                audio.set_level(level)
            if muted is not None:
                audio.set_muted(muted)
        except PcUnsupported as exc:
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "unsupported")
        except ValueError as exc:
            return CommandResult(command.id, ResultStatus.REJECTED, str(exc), "invalid_message")
        except OSError as exc:
            _log.warning("falha ao definir o volume: %s", exc)
            return CommandResult(command.id, ResultStatus.FAILED, str(exc), "failed")
        if changed is not None:
            changed()
        return CommandResult(command.id, ResultStatus.OK)

    return run


class PcVolumeAnnouncer:
    """Avisa a API do volume de agora, só quando a API aceita (`enabled`) e só o que mudou."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        audio: PcAudio,
        transport: Transport,
        envelopes: EnvelopeFactory,
        clock: Clock,
        *,
        enabled: Callable[[], bool],
        watch_seconds: float = WATCH_SECONDS,
        settle_seconds: float = SETTLE_SECONDS,
    ) -> None:
        self._audio = audio
        self._transport = transport
        self._envelopes = envelopes
        self._clock = clock
        self._enabled = enabled
        self._watch_seconds = watch_seconds
        self._settle_seconds = settle_seconds
        self._sent: VolumeState | None = None
        self._pending: asyncio.Task[None] | None = None

    def bind_enabled(self, enabled: Callable[[], bool]) -> None:
        """Liga o envio ao que a API listou em `features` (quem monta o agente a conhece depois)."""
        self._enabled = enabled

    async def announce(self, *, force: bool = False) -> None:
        """Lê o volume e o envia. Sem `force` (a leitura periódica) só se mudou desde o último
        envio. Nunca levanta erro: sem áudio, sem conexão ou sem a API aceitar, a próxima tenta."""
        if not self._enabled():
            return
        try:
            state = self._audio.read()
        except (PcUnsupported, OSError) as exc:
            _log.debug("volume não lido (%s)", exc)
            return
        if not force and state == self._sent:
            return
        try:
            await self._transport.send(self._envelopes.pc_volume_state(state.level, state.muted))
        except TransportError as exc:
            # A conexão caiu no meio: a próxima conexão avisa de novo.
            _log.debug("volume não enviado (%s)", exc)
            return
        self._sent = state

    def connection_lost(self) -> None:
        """A conexão caiu: o que a API sabia some com ela, e a próxima conexão envia de novo."""
        self._sent = None

    def soon(self) -> None:
        """Um comando acabou de mexer no volume: avisa daqui a pouco (o Windows ainda aplica a
        tecla). Mudanças em rajada (o volume segurado) viram um aviso só."""
        if self._pending is not None and not self._pending.done():
            return
        self._pending = asyncio.ensure_future(self._after_settle())

    async def _after_settle(self) -> None:
        await self._clock.sleep(self._settle_seconds)
        await self.announce()

    async def run(self) -> None:
        """A leitura periódica (tarefa de fundo supervisionada)."""
        while True:
            await self._clock.sleep(self._watch_seconds)
            await self.announce()

    async def aclose(self) -> None:
        pending = self._pending
        if pending is not None and not pending.done():
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pending


def volume_after_hello(announcer: PcVolumeAnnouncer) -> Callable[[], Awaitable[None]]:
    """O passo de depois do `hello`: o nível de agora, sempre (a conexão nova começa sem nada)."""

    async def announce() -> None:
        announcer.connection_lost()
        await announcer.announce(force=True)

    return announce
