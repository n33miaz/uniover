"""Última tentativa de abrir o canal com a API: o motivo da falha que a bandeja mostra.

O transporte anota aqui o resultado de cada abertura (antes de levantar o erro) e o estado da
bandeja lê na hora em que registra a queda. Guarda também a sequência de falhas iguais: "sem
internet" só vale com a mesma falha repetida por um tempo. Um só por processo, como o próprio
canal; quem testa passa o seu. Leve de propósito: o processo da bandeja importa este módulo pelo
`tray_status`.
"""

import threading
import time
from collections.abc import Callable

from uniover_agent.core.net_status import (
    FailureStreak,
    NetProblem,
    NetworkPresence,
    OpenFailure,
    classify,
)


class ApiReach:
    def __init__(self, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._problem: NetProblem | None = None
        self._failure: OpenFailure | None = None
        self._count = 0
        self._started = 0.0

    def opened(self) -> None:
        """A API respondeu: rede e internet estão de pé."""
        self.forget()

    def forget(self) -> None:
        """Nada a afirmar (a tentativa nem chegou à rede, ou deu certo): zera motivo e sequência."""
        with self._lock:
            self._problem = None
            self._failure = None
            self._count = 0

    def failed(self, failure: OpenFailure, presence: NetworkPresence) -> None:
        now = self._monotonic()
        with self._lock:
            if failure != self._failure:
                self._failure, self._count, self._started = failure, 0, now
            self._count += 1
            streak = FailureStreak(failure, self._count, now - self._started)
            self._problem = classify(streak, presence)

    def problem(self) -> NetProblem | None:
        with self._lock:
            return self._problem


_shared = ApiReach()


def shared_api_reach() -> ApiReach:
    return _shared
