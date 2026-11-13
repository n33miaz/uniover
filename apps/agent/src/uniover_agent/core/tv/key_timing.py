"""Quanto cada tecla da TV levou em cada trecho, resumido por janela (sem uma linha por tecla).

Os trechos de uma tecla:

* **idade**: do envio pela API até a chegada ao agente (pelo `ClockOffset`; sem referência de
  relógio ou pelo canal direto, não há);
* **fila**: da chegada até a vez dela na cadeia das teclas;
* **sessão**: da vez dela até a sessão com a TV estar pronta (abrir, acordar, reabrir);
* **envio**: do driver recebendo a tecla até ele devolver. Na Android TV o protocolo não confirma
  (a escrita vai ao buffer e volta logo); na Samsung é a ida e volta do comando;
* **total**: a idade mais tudo o que a tecla passou dentro do agente.

O caminho quente só soma números a listas limitadas; percentis e registro saem no resumo, uma vez
por janela com uso. Tecla lenta (total acima do limite) ganha uma linha própria, poucas por janela.
"""

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import Final

_log = logging.getLogger(__name__)

# Acima disto (ponta a ponta) a tecla é lenta e ganha uma linha própria.
SLOW_KEY_MS: Final = 300.0
# Linhas de tecla lenta por janela: numa queda toda tecla é lenta, e uma linha por tecla voltaria.
SLOW_LINES_PER_WINDOW: Final = 5
# Amostras guardadas por janela (uma rajada presa não faz a memória crescer); a contagem segue.
MAX_SAMPLES: Final = 1024
REPORT_EVERY_SECONDS: Final = 60.0
# A idade acima disto é a da tecla velha, descartada antes da TV (`KEY_MAX_AGE_SECONDS` dos
# handlers): no ponta a ponta ela satura aqui; acima (ou negativa) é relógio fora de hora e conta à
# parte, fora dos percentis.
AGE_LIMIT_SECONDS: Final = 1.5
OUTCOME_OK: Final = "ok"
_NS_PER_MS: Final = 1_000_000
# As únicas teclas que vão pelo nome à linha de tecla lenta. Qualquer outra (dígitos `NUM_*`, que
# compõem um PIN; `TYPE_*`, caracteres do que se digita; o que vier depois) sai como "outra".
NAMED_KEYS: Final = frozenset(
    {
        "UP",
        "DOWN",
        "LEFT",
        "RIGHT",
        "OK",
        "BACK",
        "HOME",
        "MENU",
        "POWER",
        "INPUT",
        "VOLUME_UP",
        "VOLUME_DOWN",
        "MUTE",
        "CHANNEL_UP",
        "CHANNEL_DOWN",
        "PLAY_PAUSE",
        "MEDIA_NEXT",
        "MEDIA_PREVIOUS",
    }
)
OTHER_KEY: Final = "outra"


def percentile(sorted_values: list[float], fraction: float) -> float:
    """Percentil pelo posto mais próximo (lista já ordenada e não vazia)."""
    index = max(0, min(len(sorted_values) - 1, math.ceil(fraction * len(sorted_values)) - 1))
    return sorted_values[index]


def key_label(key: str) -> str:
    """O nome da tecla para o registro: só as da lista permitida; as outras, "outra"."""
    return key if key in NAMED_KEYS else OTHER_KEY


class _Metric:
    """Um trecho na janela: amostras limitadas (para os percentis) e o máximo da janela inteira."""

    __slots__ = ("maximum", "values")

    def __init__(self) -> None:
        self.values: list[float] = []
        self.maximum = 0.0

    def add(self, value: float, room: bool) -> None:
        self.maximum = max(self.maximum, value)
        if room:
            self.values.append(value)

    def stats(self) -> str:
        """`p50/p95/máx` em ms (o máximo vale para a janela toda, mesmo além das amostras)."""
        if not self.values:
            return "n/d"
        ordered = sorted(self.values)
        return (
            f"p50 {percentile(ordered, 0.5):.0f}/p95 {percentile(ordered, 0.95):.0f}/"
            f"máx {self.maximum:.0f}"
        )


class KeyTimings:
    """Acumula os tempos das teclas da TV e os resume a cada `report_every` segundos com uso."""

    def __init__(  # noqa: PLR0913 - tudo opcional e trocável para os testes
        self,
        *,
        version: str,
        driver: str,
        slow_ms: float = SLOW_KEY_MS,
        slow_lines: int = SLOW_LINES_PER_WINDOW,
        max_samples: int = MAX_SAMPLES,
        report_every: float = REPORT_EVERY_SECONDS,
        age_limit: float = AGE_LIMIT_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._version = version
        self._driver = driver
        self._slow_ms = slow_ms
        self._slow_lines = slow_lines
        self._max_samples = max_samples
        self._report_every = report_every
        self._age_limit_ms = age_limit * 1_000
        self._sleep = sleep
        self._reset()

    def _reset(self) -> None:
        self._count = 0
        self._slow = 0
        self._slow_logged = 0
        self._bad_age = 0
        self._paths: dict[str, int] = {}
        self._outcomes: dict[str, int] = {}
        self._age = _Metric()
        self._queue = _Metric()
        self._session = _Metric()
        self._send = _Metric()
        self._total = _Metric()

    def record(  # noqa: PLR0913 - um trecho por argumento
        self,
        *,
        key: str,
        path: str | None,
        outcome: str,
        age: float | None,
        queue_ns: int,
        session_ns: int | None,
        send_ns: int | None,
    ) -> None:
        """Uma tecla terminou (`age` em segundos; trechos em nanossegundos; `None`: não houve)."""
        queue_ms = queue_ns / _NS_PER_MS
        session_ms = session_ns / _NS_PER_MS if session_ns is not None else None
        send_ms = send_ns / _NS_PER_MS if send_ns is not None else None
        age_ms = age * 1_000 if age is not None else None
        bad_age = age_ms is not None and not 0.0 <= age_ms <= self._age_limit_ms
        if age_ms is not None and bad_age:
            # Relógio fora de hora: no ponta a ponta satura no limite; fora dos percentis da idade.
            self._bad_age += 1
            age_ms = min(max(age_ms, 0.0), self._age_limit_ms)
        total_ms = (age_ms or 0.0) + queue_ms + (session_ms or 0.0) + (send_ms or 0.0)
        self._count += 1
        label = path or "?"
        self._paths[label] = self._paths.get(label, 0) + 1
        self._outcomes[outcome] = self._outcomes.get(outcome, 0) + 1
        room = len(self._total.values) < self._max_samples
        self._total.add(total_ms, room)
        self._queue.add(queue_ms, room)
        if age_ms is not None and not bad_age:
            self._age.add(age_ms, room)
        if session_ms is not None:
            self._session.add(session_ms, room)
        if send_ms is not None:
            self._send.add(send_ms, room)
        if total_ms <= self._slow_ms:
            return
        self._slow += 1
        if self._slow_logged >= self._slow_lines:
            return
        self._slow_logged += 1
        _log.info(
            "tecla lenta da TV: %.0f ms ponta a ponta | idade %s | fila %.0f | sessão %s | "
            "envio %s | caminho %s | resultado %s | tecla %s | driver %s | agente %s",
            total_ms,
            "inválida" if bad_age else f"{age_ms:.0f}" if age_ms is not None else "n/d",
            queue_ms,
            f"{session_ms:.0f}" if session_ms is not None else "n/d",
            f"{send_ms:.0f}" if send_ms is not None else "n/d",
            label,
            outcome,
            key_label(key),
            self._driver,
            self._version,
        )

    def report(self) -> None:
        """Escreve o resumo da janela (só se houve tecla) e zera a janela."""
        if self._count:
            paths = ", ".join(f"{name} {n}" for name, n in sorted(self._paths.items()))
            outcomes = ", ".join(f"{name} {n}" for name, n in sorted(self._outcomes.items()))
            slow = f"{self._slow}"
            if self._slow > self._slow_logged:
                slow += f" ({self._slow_logged} detalhadas)"
            age = self._age.stats()
            if self._bad_age:
                age += f" (inválida {self._bad_age})"
            _log.info(
                "teclas da TV no último minuto: %d (%s; %s) | ms ponta a ponta %s | idade %s | "
                "fila %s | sessão %s | envio %s | lentas (>%.0f ms) %s | driver %s | agente %s",
                self._count,
                paths,
                outcomes,
                self._total.stats(),
                age,
                self._queue.stats(),
                self._session.stats(),
                self._send.stats(),
                self._slow_ms,
                slow,
                self._driver,
                self._version,
            )
        self._reset()

    async def run(self) -> None:
        while True:
            await self._sleep(self._report_every)
            self.report()

    async def aclose(self) -> None:
        """No encerramento (entre os `closers` da TV, depois do dreno das teclas em curso): a
        janela corrente sai no registro em vez de se perder com a tarefa do resumo."""
        self.report()
