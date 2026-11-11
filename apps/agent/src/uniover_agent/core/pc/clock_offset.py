"""Idade de um comando do PC: o relógio da API medido contra o monotônico deste agente.

O `ts` de cada mensagem é a hora do relógio da API. Medir a idade só com `agora - ts` trata um PC
com o relógio adiantado como se tudo chegasse velho. Aqui a idade usa o relógio **monotônico** do
agente, que ninguém acerta: a amostra de um batimento é `monotônico - ts`, o menor valor numa janela
recente aproxima a diferença entre as duas escalas somada à menor latência de entrega, e a idade de
um comando é o quanto ele passou além disso. Acertar o relógio do PC não muda nada: só o relógio da
API importa.

Só o batimento da API (`api.keepalive.v1`, que ela nunca segura) alimenta a estimativa. Um comando
`pc.*` nunca a alimenta: se tivesse sido segurado e entregue tarde, viraria a referência de
"agora" e passaria como novo.

A estimativa só vale depois de DOIS batimentos que concordam entre si (diferença menor que a margem
alta): um primeiro batimento ruim sozinho não vira a referência. Sem estimativa (o agente acabou de
conectar, ou ficou mais de 5 minutos sem batimento, por exemplo depois de suspender) a idade é
desconhecida e o comando vale como chegou. A API manda um batimento logo depois do `hello`, então a
janela se enche em instantes; e ela já não segura comando `pc.*` durante uma reconexão, de modo que
esta checagem é defesa em profundidade, não a guarda principal.

A estimativa se corrige sozinha: se vários batimentos seguidos saem todos bem ACIMA do mínimo (o
relógio da API recuou, ou o mínimo antigo veio de uma amostra boa demais), ou bem ABAIXO dele (a API
avançou, ou o monotônico parou durante a suspensão), a estimativa é refeita a partir deles. Um
batimento isolado fora do esperado não conta.

A hora do relógio do PC só entra no AVISO de relógio fora de hora (diagnóstico).
"""

import logging
import threading
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
# Batimentos seguidos fora do esperado que bastam para refazer a estimativa.
REBASE_AFTER: Final = 3
# Quanto um batimento acima do mínimo precisa estar para contar como "alto demais" (também é a
# diferença máxima entre os dois batimentos que confirmam a estimativa) e quanto abaixo para contar
# como "baixo demais" (um carimbo no futuro).
HIGH_MARGIN_SECONDS: Final = 0.5
LOW_MARGIN_SECONDS: Final = 5.0
# Recusas seguidas de movimento do mouse por idade que merecem aviso (nada morre calado).
POINTER_DROP_WARNING: Final = 20
# Pares de batimentos que não concordaram, um depois do outro, sem a estimativa se formar: o enlace
# oscila demais e fica visível no diagnóstico.
UNSTABLE_AFTER: Final = 10

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
    `on_refused(idade)` roda a cada comando recusado por idade e quando o movimento do mouse vem
    sendo descartado sem parar (o registro do diagnóstico junta as repetições). O aviso no log sai
    uma vez só, aqui, e não em cada handler.

    Os batimentos chegam pelo laço principal do agente e a idade é lida pelo laço da entrada do PC
    (outra thread): o estado é protegido por uma trava, e os avisos (`on_*`) não podem bloquear.
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
        on_unstable: Callable[[int], None] | None = None,
    ) -> None:
        self._now = now  # só para o aviso de relógio fora de hora
        self._monotonic = monotonic
        self._window = window_seconds
        self._large = large_seconds
        self._on_skew = on_skew
        self._on_refused = on_refused
        self._on_unstable = on_unstable
        # Cada balde: (início em tempo monotônico, menor `monotônico - ts`, menor `agora - ts`).
        self._buckets: deque[tuple[float, float, float]] = deque()
        # Batimentos seguidos fora do esperado: (monotônico - ts, agora - ts) de cada um.
        self._off_high: list[tuple[float, float]] = []
        self._off_low: list[tuple[float, float]] = []
        # O primeiro batimento de uma janela vazia espera um segundo que concorde: (início,
        # monotônico - ts, agora - ts).
        self._candidate: tuple[float, float, float] | None = None
        self._rejected_pairs = 0
        self._large_now = False
        self._warned = False
        self._pointer_drops = 0
        self._lock = threading.RLock()

    @property
    def offset(self) -> float | None:
        """O menor `monotônico - ts` da janela (escala arbitrária), ou `None` sem amostras."""
        with self._lock:
            self._prune()
            return min((mono for _, mono, _ in self._buckets), default=None)

    @property
    def wall_difference(self) -> float | None:
        """O menor `agora - ts` da janela: quanto o relógio do PC está adiantado (para o aviso)."""
        with self._lock:
            self._prune()
            return min((wall for _, _, wall in self._buckets), default=None)

    def observe(self, sent_at: str | None) -> None:
        """Conta o `ts` de um batimento da API (sem `ts` utilizável, não conta)."""
        with self._lock:
            self._observe(sent_at)

    def _observe(self, sent_at: str | None) -> None:
        sent = _parse(sent_at)
        if sent is None:
            return
        at = self._monotonic()
        mono = at - sent.timestamp()
        wall = (self._now() - sent).total_seconds()
        offset = self.offset  # já sem as amostras fora da janela
        if offset is None:
            # Janela vazia: uma sequência de fora-do-esperado de antes não vale mais, senão um só
            # batimento depois da confirmação completaria os três e refaria a estimativa.
            self._off_high.clear()
            self._off_low.clear()
            self._confirm(at, mono, wall)
            return
        if self._is_outlier(mono, wall, offset):
            if self._rebase_due():
                self._rebase(at)
                self._check_large()
            return
        self._off_high.clear()
        self._off_low.clear()
        self._add(at, mono, wall)
        self._check_large()

    def age(self, sent_at: str | None) -> float | None:
        """Quanto o comando passou além da referência: `(monotônico - ts)` menos a estimativa.

        `None` quando não dá para saber (o `ts` não presta, ou ainda não há estimativa confirmada):
        o comando vale como veio.
        """
        sent = _parse(sent_at)
        offset = self.offset
        if sent is None or offset is None:
            return None
        return max(0.0, (self._monotonic() - sent.timestamp()) - offset)

    def refused(self, age: float) -> None:
        if self._on_refused is not None:
            self._on_refused(age)

    def pointer_result(self, *, dropped: bool, age: float = 0.0) -> None:
        """Conta descartes seguidos do movimento do mouse por idade; avisa uma vez por sequência."""
        with self._lock:
            if not dropped:
                self._pointer_drops = 0
                return
            self._pointer_drops += 1
            warn = self._pointer_drops == POINTER_DROP_WARNING + 1
            drops = self._pointer_drops
        if warn:
            _log.warning(
                "o movimento do mouse vem sendo descartado por idade (%d seguidos): rede lenta ou "
                "relógio fora de hora; o mouse não vai responder direito",
                drops,
            )
            self.refused(age)

    def _confirm(self, at: float, mono: float, wall: float) -> None:
        """Janela vazia: o batimento espera outro que concorde; só então a estimativa existe."""
        candidate = self._candidate
        if candidate is not None and at - candidate[0] <= self._window:
            start, first_mono, first_wall = candidate
            if abs(mono - first_mono) <= HIGH_MARGIN_SECONDS:
                self._candidate = None
                self._rejected_pairs = 0
                self._add(start, first_mono, first_wall)
                self._add(at, mono, wall)
                self._check_large()
                return
            self._rejected_pairs += 1
            if self._rejected_pairs == UNSTABLE_AFTER:
                _log.debug(
                    "os batimentos da API não concordam (%d pares seguidos): enlace instável, "
                    "a idade dos comandos do PC segue desconhecida",
                    self._rejected_pairs,
                )
                if self._on_unstable is not None:
                    self._on_unstable(self._rejected_pairs)
        else:
            self._rejected_pairs = 0
        self._candidate = (at, mono, wall)

    def _is_outlier(self, mono: float, wall: float, offset: float) -> bool:
        if mono > offset + HIGH_MARGIN_SECONDS:
            self._off_high.append((mono, wall))
            self._off_low.clear()
            return True
        if mono < offset - LOW_MARGIN_SECONDS:
            self._off_low.append((mono, wall))
            self._off_high.clear()
            return True
        return False

    def _rebase_due(self) -> bool:
        return max(len(self._off_high), len(self._off_low)) >= REBASE_AFTER

    def _rebase(self, at: float) -> None:
        streak = self._off_high or self._off_low
        self._buckets.clear()
        self._add(at, min(m for m, _ in streak), min(w for _, w in streak))
        self._off_high.clear()
        self._off_low.clear()

    def _add(self, at: float, mono: float, wall: float) -> None:
        if self._buckets and at - self._buckets[-1][0] < _BUCKET_SECONDS:
            start, low_mono, low_wall = self._buckets[-1]
            self._buckets[-1] = (start, min(low_mono, mono), min(low_wall, wall))
        else:
            self._buckets.append((at, mono, wall))

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
                    "a idade dos comandos do PC usa o relógio monotônico, não o do PC",
                    difference,
                )
            if self._on_skew is not None and difference is not None:
                self._on_skew(difference)
        self._large_now = is_large
