"""Como o agente vê a TV: o que a última sondagem ou mudança de estado mostrou, e por quê.

A API só recebe o `tv.state.v1` (com o `mode` opcional, quando há prova de que a TV está desligada,
em standby ou no Modo Dormir). O quadro completo, que separa não alcançar a TV de ela estar
desligada de propósito, com o instante e o motivo, fica aqui e no registro do agente.
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, runtime_checkable

from uniover_agent.core.domain import TvMode
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

TvPresenceStatus = Literal["unreachable", "unresponsive", "off", "standby", "sleep", "ready"]
TvProbeResult = Literal["reachable", "unreachable", "unresponsive", "off", "standby"]

# As teclas que o Modo Dormir deixa passar sem acordar a tela (volume e mídia).
SLEEP_PASS_THROUGH_KEYS = frozenset(
    {
        "VOLUME_UP",
        "VOLUME_DOWN",
        "MUTE",
        "PLAY_PAUSE",
        "PLAY",
        "PAUSE",
        "STOP",
        "REWIND",
        "FAST_FORWARD",
        "MEDIA_NEXT",
        "MEDIA_PREVIOUS",
    }
)


@dataclass(frozen=True, slots=True)
class TvPresence:
    status: TvPresenceStatus
    reason: str
    # Quando foi observado pela última vez (UTC).
    at: datetime


@runtime_checkable
class ReportsPowerMode(Protocol):
    """Driver que sabe dizer de que jeito a TV está desligada (a Samsung separa `standby`)."""

    @property
    def power_mode(self) -> TvMode | None:
        """O da última leitura de energia; `None` se ela não disse ou a TV está ligada."""
        ...


@runtime_checkable
class SleepScreenObserver(Protocol):
    """Quem precisa saber que o Modo Dormir abriu ou saiu da frente."""

    def sleep_screen_opened(self, package: str, minutes: int | None) -> None: ...

    def sleep_screen_closed(self) -> None: ...


def open_session_presence(mode: TvMode | None) -> tuple[TvPresenceStatus, str]:
    """O que uma sessão aberta mostra: o modo relatado ou a TV pronta."""
    if mode == "off":
        return "off", "a TV informou que está desligada"
    if mode == "standby":
        return "standby", "a TV informou que está em standby"
    if mode == "sleep":
        return "sleep", "o Modo Dormir foi aberto pelo agente"
    return "ready", "a sessão com a TV está aberta"


class PresenceLog:
    """Guarda a última observação e registra cada mudança (repetições só em depuração)."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self.current: TvPresence | None = None

    def note(self, status: TvPresenceStatus, reason: str) -> None:
        previous = self.current
        self.current = TvPresence(status, reason, self._clock.now())
        changed = previous is None or (previous.status, previous.reason) != (status, reason)
        _log.log(
            logging.INFO if changed else logging.DEBUG,
            "presença da TV: %s (%s) em %s",
            status,
            reason,
            self.current.at.isoformat(timespec="seconds"),
        )
