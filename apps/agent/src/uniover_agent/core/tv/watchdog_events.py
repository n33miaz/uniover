"""Eventos `tv.watchdog.v1` do vigia: montados na hora, entregues quando há conexão com a API.

Nada aqui pode atrasar nem derrubar o reparo: `emit` só monta o envelope e o guarda na fila em
memória (no máximo 100; sem disco), e `flush` entrega na ordem quando o transporte está conectado.
Falha de envio deixa o envelope na fila para a próxima conexão.
"""

import asyncio
import logging
from collections import deque
from typing import Any, Final, Literal

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import Clock, Transport

_log = logging.getLogger(__name__)

WatchdogKind = Literal["repair_started", "repaired", "repair_failed", "adb_unreachable"]
WatchdogSeverity = Literal["info", "warn", "error"]

# O mesmo tipo de evento em menos que isto não é repetido (uma TV que cai a cada minuto não inunda).
DEDUPE_SECONDS: Final = 60.0
BUFFER_LIMIT: Final = 100
SEND_TIMEOUT_SECONDS: Final = 5.0


class WatchdogEvents:
    def __init__(self, transport: Transport, envelopes: EnvelopeFactory, clock: Clock) -> None:
        self._transport = transport
        self._envelopes = envelopes
        self._clock = clock
        self._queue: deque[dict[str, Any]] = deque(maxlen=BUFFER_LIMIT)
        self._last_at: dict[str, float] = {}
        self._flushing = asyncio.Lock()

    @property
    def pending(self) -> int:
        return len(self._queue)

    def emit(
        self, kind: WatchdogKind, severity: WatchdogSeverity, detail: str, attempts: int = 0
    ) -> bool:
        """Guarda o evento para entrega; devolve `False` se foi descartado por repetição.

        `detail` é texto curto e fixo: nunca endereço da TV, caminho ou saída de comando.
        """
        now = self._clock.monotonic()
        previous = self._last_at.get(kind)
        if previous is not None and now - previous < DEDUPE_SECONDS:
            return False
        try:
            envelope = self._envelopes.tv_watchdog(kind, severity, detail[:200], attempts)
        except Exception:
            _log.exception("não consegui montar o evento do vigia")
            return False
        self._last_at[kind] = now
        self._queue.append(envelope)
        return True

    async def flush(self) -> None:
        """Entrega a fila na ordem; sem conexão ou com falha, o que sobra fica para depois."""
        async with self._flushing:
            while self._queue and self._transport.connected:
                try:
                    await asyncio.wait_for(
                        self._transport.send(self._queue[0]), SEND_TIMEOUT_SECONDS
                    )
                except Exception as exc:
                    _log.debug("eventos do vigia aguardam a conexão (%s)", type(exc).__name__)
                    return
                self._queue.popleft()
