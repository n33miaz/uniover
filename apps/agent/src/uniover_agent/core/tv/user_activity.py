"""Quando alguém está diante da tela da TV no app: a hora de o agente abrir ADB sozinho.

Uma conexão ADB nova a uma TV que perdeu a permissão (reset de fábrica, revogação) faz aparecer o
aviso "Permitir depuração USB". Sem ninguém diante da tela da TV no app ninguém o veria, então a
partida, o vigia e as tarefas de fundo só usam um transporte que já está aberto.

O sinal é **explícito**: `tv.presence.v1`, que a tela da TV manda quando alguém **toca nela** (nunca
por tempo: uma aba esquecida aberta não manda nada). O tipo de
um comando não prova ninguém (o atalho do iPhone e o desligamento agendado mandam teclas e abrem
apps sem pessoa na tela), então tecla, texto e afins não contam. Dentro de `WINDOW_SECONDS` depois
de um sinal, abrir a conexão é parte do uso. Os pedidos da pessoa que já levam a marca de
`user_initiated_adb` (Atualizar lista, TV Livre) não dependem deste sinal.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler

WINDOW_SECONDS: Final = 60.0
# Idade máxima de um sinal de presença (pelo `ts` do envelope): mais velho que isto é ignorado.
MAX_SIGNAL_AGE_SECONDS: Final = 15.0
# Folga para o relógio do PC estar um pouco atrás do da API (idade negativa): além disso o sinal
# é recusado, senão um relógio muito atrasado aceitaria até um sinal entregue com atraso.
MAX_CLOCK_SKEW_SECONDS: Final = 5.0
# Declarada no `agent.hello.v1`: a API só manda `tv.presence.v1` a quem a tem.
PRESENCE_CAPABILITY: Final = "tv.presence.v1"
PRESENCE_TYPE: Final = "tv.presence.v1"

_log = logging.getLogger(__name__)


class UserActivity:
    """O último sinal de presença que chegou do app para esta TV."""

    def __init__(
        self, monotonic: Callable[[], float], window_seconds: float = WINDOW_SECONDS
    ) -> None:
        self._monotonic = monotonic
        self._window = window_seconds
        self._last: float | None = None

    def touch(self) -> None:
        self._last = self._monotonic()

    def recent(self) -> bool:
        return self._last is not None and self._monotonic() - self._last <= self._window


def _age_seconds(sent_at: str | None, now: datetime) -> float | None:
    if not sent_at:
        return None
    try:
        sent = datetime.fromisoformat(sent_at)
    except ValueError:
        return None
    if sent.tzinfo is None:
        return None
    return (now - sent).total_seconds()


def tv_presence_handler(
    activity: UserActivity,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    max_age_seconds: float = MAX_SIGNAL_AGE_SECONDS,
    max_skew_seconds: float = MAX_CLOCK_SKEW_SECONDS,
) -> Handler:
    """`tv.presence.v1`: alguém tocou na tela da TV. Sem resposta (a API não a espera).

    Um sinal que o gateway segurou (agente reconectando) chega velho: o `ts` do envelope é a hora
    em que a API o montou, e acima de `max_age_seconds` ele é ignorado, senão a janela de 60 s
    começaria na chegada e não no toque. Idade negativa (relógio do PC atrás do da API) vale até
    `max_skew_seconds`. Sem `ts` utilizável vale como chegou. Se os relógios diferem tanto que o
    sinal é recusado, avisa **uma vez** no log (a causa seria invisível: nada reconectaria sozinho).
    """
    warned = False

    async def handle(command: Command) -> CommandResult:
        nonlocal warned
        age = _age_seconds(command.sent_at, now())
        if age is None or -max_skew_seconds <= age <= max_age_seconds:
            activity.touch()
        elif not warned:
            warned = True
            _log.warning(
                "sinal de presença da TV recusado: o `ts` dele tem %.0f s de diferença para o "
                "relógio deste PC (atraso na entrega ou relógio do PC fora de hora)",
                age,
            )
        return CommandResult(command.id, ResultStatus.OK)

    return handle
