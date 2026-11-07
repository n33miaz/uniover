"""Diferença entre o relógio deste PC e o da API, estimada pelo que chega.

O `ts` de cada mensagem é a hora do relógio da API. Medir a idade só com `agora - ts` trata um PC
com o relógio adiantado como se tudo chegasse velho. Aqui a idade é medida com o relógio
**monotônico** do agente, que ninguém acerta: a amostra de uma mensagem é `monotônico - ts`, o menor
valor visto numa janela recente aproxima a diferença entre as duas escalas somada à menor latência
de entrega, e a idade de um comando é o quanto ele passou além disso. Um comando entregue 10 s
depois dos demais tem 10 s, e acertar o relógio do PC (para a frente ou para trás) não muda nada:
só o relógio da API importa. A API manda um batimento (`api.keepalive.v1`) a cada 25 s, então
sempre há amostras na janela.

Suspender o PC não faz comando nenhum parecer velho. Se o relógio monotônico conta o tempo
suspenso, ele e o da API andam juntos e a diferença não muda; se não conta, as amostras seguintes
saem MENORES e a estimativa baixa na hora (o mínimo da janela as acompanha). Por isso não há
reinício da estimativa depois de uma pausa longa: ele só enfraqueceria a recusa do comando que a
API segurou durante uma reconexão (a primeira mensagem depois de reconectar seria aceita sem
referência).

A hora do relógio do PC só entra no AVISO de relógio fora de hora (diagnóstico), nunca na idade.
Sem nenhuma amostra ainda (logo depois de iniciar) a idade é desconhecida e o comando vale como
chegou.
"""

import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

# Quanto tempo uma amostra conta. O batimento da API vem a cada 25 s: sobram amostras na janela.
WINDOW_SECONDS: Final = 300.0
# As amostras são agrupadas em baldes deste tamanho, para a conta não crescer com o tráfego.
_BUCKET_SECONDS: Final = 10.0
# Diferença de relógio (PC contra API) que merece aviso; a latência real é bem menor que isto.
LARGE_OFFSET_SECONDS: Final = 5.0

_log = logging.getLogger(__name__)


def _parse(sent_at: str | None) -> datetime | None:
    if not sent_at:
        return None
    try:
        sent = datetime.fromisoformat(sent_at)
    except ValueError:
        return None
    return sent if sent.tzinfo is not None else None


class ClockOffset:
    """Estimativa da diferença de relógio e o único ponto que avisa sobre ela.

    `on_skew(diferença)` roda quando o relógio do PC passa a diferir muito do da API;
    `on_refused(idade)` roda a cada comando recusado por idade (o registro do diagnóstico junta as
    repetições). O aviso no log sai uma vez só, aqui, e não em cada handler.
    """

    def __init__(  # noqa: PLR0913 - tudo opcional e trocável para os testes
        self,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        monotonic: Callable[[], float] = time.monotonic,
        window_seconds: float = WINDOW_SECONDS,
        large_seconds: float = LARGE_OFFSET_SECONDS,
        on_skew: Callable[[float], None] | None = None,
        on_refused: Callable[[float], None] | None = None,
    ) -> None:
        self._now = now  # só para o aviso: a idade não usa o relógio de parede
        self._monotonic = monotonic
        self._window = window_seconds
        self._large = large_seconds
        self._on_skew = on_skew
        self._on_refused = on_refused
        # Cada balde: (início em tempo monotônico, menor `monotônico - ts`, menor `agora - ts`).
        self._buckets: deque[tuple[float, float, float]] = deque()
        self._large_now = False
        self._warned = False

    @property
    def offset(self) -> float | None:
        """O menor `monotônico - ts` da janela (escala arbitrária), ou `None` sem amostras."""
        self._prune()
        return min((mono for _, mono, _ in self._buckets), default=None)

    @property
    def wall_difference(self) -> float | None:
        """O menor `agora - ts` da janela: quanto o relógio do PC está adiantado (para o aviso)."""
        self._prune()
        return min((wall for _, _, wall in self._buckets), default=None)

    def observe(self, sent_at: str | None) -> None:
        """Conta a amostra de uma mensagem que veio da API (sem `ts` utilizável, não conta)."""
        sent = _parse(sent_at)
        if sent is None:
            return
        at = self._monotonic()
        mono = at - sent.timestamp()
        wall = (self._now() - sent).total_seconds()
        if self._buckets and at - self._buckets[-1][0] < _BUCKET_SECONDS:
            start, low_mono, low_wall = self._buckets[-1]
            self._buckets[-1] = (start, min(low_mono, mono), min(low_wall, wall))
        else:
            self._buckets.append((at, mono, wall))
        self._check_large()

    def age(self, sent_at: str | None) -> float | None:
        """Quanto o comando passou além da menor espera recente; `None` se não dá para saber."""
        sent = _parse(sent_at)
        offset = self.offset
        if sent is None or offset is None:
            return None
        return max(0.0, (self._monotonic() - sent.timestamp()) - offset)

    def refused(self, age: float) -> None:
        if self._on_refused is not None:
            self._on_refused(age)

    def _prune(self) -> None:
        limit = self._monotonic() - self._window
        while self._buckets and self._buckets[0][0] < limit:
            self._buckets.popleft()

    def _check_large(self) -> None:
        difference = self.wall_difference
        is_large = difference is not None and abs(difference) > self._large
        if is_large and not self._large_now:
            if not self._warned:
                self._warned = True
                _log.warning(
                    "o relógio deste PC difere %.0f s do da API (relógio do PC fora de hora?); "
                    "os comandos do PC seguem valendo: a idade deles não usa o relógio do PC",
                    difference,
                )
            if self._on_skew is not None and difference is not None:
                self._on_skew(difference)
        self._large_now = is_large
