"""Uma trava com duas filas: o que a pessoa faz agora passa à frente da manutenção."""

import asyncio
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from types import TracebackType
from typing import Final

# Envelhecimento da fila comum: com alguém nela, depois de tantas vezes seguidas dadas a urgentes,
# ou de tanto tempo de espera do mais antigo, a próxima vez é dele (digitação longa não trava a
# lista de apps para sempre).
MAX_URGENT_STREAK: Final = 8
MAX_NORMAL_WAIT_SECONDS: Final = 2.0


class PriorityLock:
    """Trava de um dono por vez, com a vez entregue primeiro a quem pediu com `urgent`.

    Sem `urgent` vale como `asyncio.Lock` (por ordem de chegada). Ao soltar, a vez vai direto para
    o próximo da fila urgente; sem ninguém nela, para a fila comum. A fila comum não morre de fome:
    depois de `max_urgent_streak` vezes seguidas dadas a urgentes com ela esperando, ou com o mais
    antigo dela esperando `max_normal_wait` segundos, a próxima vez é dela. Quem já recebeu a vez
    não a perde para um urgente que chegou depois.
    """

    def __init__(
        self,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        max_urgent_streak: int = MAX_URGENT_STREAK,
        max_normal_wait: float = MAX_NORMAL_WAIT_SECONDS,
    ) -> None:
        self._monotonic = monotonic
        self._max_streak = max_urgent_streak
        self._max_wait = max_normal_wait
        self._locked = False
        self._urgent: deque[asyncio.Future[None]] = deque()
        # Cada um com o instante em que entrou na fila (para o envelhecimento).
        self._normal: deque[tuple[asyncio.Future[None], float]] = deque()
        # Vezes seguidas dadas a urgentes enquanto havia alguém na fila comum.
        self._streak = 0

    def locked(self) -> bool:
        return self._locked

    async def acquire(self, *, urgent: bool = False) -> bool:
        if not self._locked and not self._urgent and not self._normal:
            self._locked = True
            return True
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        entry = (waiter, self._monotonic())
        if urgent:
            self._urgent.append(waiter)
        else:
            self._normal.append(entry)
        try:
            await waiter
        except asyncio.CancelledError:
            if waiter.done() and not waiter.cancelled():
                # Recebeu a vez e foi cancelado antes de usá-la: passa adiante.
                self.release()
            elif urgent and waiter in self._urgent:
                self._urgent.remove(waiter)
            elif not urgent and entry in self._normal:
                self._normal.remove(entry)
            raise
        return True

    def release(self) -> None:
        if not self._locked:
            raise RuntimeError("trava solta sem estar presa")
        self._drop_abandoned()
        if self._normal and (not self._urgent or self._normal_is_due()):
            waiter, _ = self._normal.popleft()
            self._streak = 0
        elif self._urgent:
            waiter = self._urgent.popleft()
            self._streak = self._streak + 1 if self._normal else 0
        else:
            self._locked = False
            return
        # A vez passa direto (a trava continua presa, agora por ele).
        waiter.set_result(None)

    def _normal_is_due(self) -> bool:
        _, since = self._normal[0]
        return self._streak >= self._max_streak or self._monotonic() - since >= self._max_wait

    def _drop_abandoned(self) -> None:
        # Um cancelado ainda na fila (antes de o `except` dele rodar) não recebe a vez.
        while self._urgent and self._urgent[0].done():
            self._urgent.popleft()
        while self._normal and self._normal[0][0].done():
            self._normal.popleft()

    @asynccontextmanager
    async def urgent(self) -> AsyncIterator[None]:
        """`async with lock.urgent():` pega a trava à frente de quem espera sem urgência."""
        await self.acquire(urgent=True)
        try:
            yield
        finally:
            self.release()

    async def __aenter__(self) -> None:
        await self.acquire()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
