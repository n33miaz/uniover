"""Auto-diagnóstico periódico e auto-reparo seguro do agente.

De tempos em tempos o agente confere a própria saúde (pasta de instalação, tarefa de início
automático, supervisor, conexão com a API, TV alcançável, tarefas de fundo). Cada verificação diz em
uma frase o que viu; se falhou e existe um reparo **seguro** (refazer a pasta, registrar de novo a
tarefa, reiniciar o processo pelo supervisor), ele é tentado, uma verificação por vez, com espera
entre tentativas e um teto por dia. Tudo vai para o registro local e, como ocorrência, para a tela
do administrador.

O núcleo não sabe o que cada verificação confere: elas vêm prontas por injeção (`Check`).
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Final, Literal

from uniover_agent.core.diagnostics import DiagnosticsRecorder, component_safe
from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

FIRST_RUN_SECONDS: Final = 90.0
INTERVAL_SECONDS: Final = 600.0
# Depois de tentar reparar uma verificação, só tenta de novo depois disto.
REPAIR_COOLDOWN_SECONDS: Final = 1800.0
# Teto de tentativas por verificação em 24 h: um reparo que não resolve não vira laço.
MAX_REPAIRS_PER_DAY: Final = 4
_DAY_SECONDS: Final = 24 * 3600.0


@dataclass(frozen=True, slots=True)
class CheckResult:
    """O que uma verificação viu. `fixable`: o reparo da própria verificação pode resolver."""

    ok: bool
    detail: str
    fixable: bool = False
    # `warn`: vale registrar, mas não é defeito (TV desligada). `error`: o agente não faz o que
    # devia.
    severity: Literal["warn", "error"] = "error"
    # Falha que, numa versão recém-instalada ainda em prova, justifica voltar à anterior.
    critical: bool = False


@dataclass(frozen=True, slots=True)
class Check:
    name: str
    run: Callable[[], Awaitable[CheckResult]]
    repair: Callable[[], Awaitable[str | None]] | None = None
    # Frase curta do que o reparo faz, para o registro ("tarefa de início automático refeita").
    repair_label: str = ""


@dataclass(frozen=True, slots=True)
class Outcome:
    name: str
    result: CheckResult
    repaired: bool = False
    repair_error: str | None = None


@dataclass(slots=True)
class _RepairHistory:
    last: float | None = None
    attempts: list[float] = field(default_factory=list)


class SelfCare:
    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        checks: Sequence[Check],
        recorder: DiagnosticsRecorder,
        clock: Clock,
        *,
        interval: float = INTERVAL_SECONDS,
        first_run: float = FIRST_RUN_SECONDS,
        cooldown: float = REPAIR_COOLDOWN_SECONDS,
        on_critical: Callable[[Outcome], Awaitable[None]] | None = None,
    ) -> None:
        self._checks = tuple(checks)
        self._recorder = recorder
        self._clock = clock
        self._interval = interval
        self._first_run = first_run
        self._cooldown = cooldown
        self._on_critical = on_critical
        self._history: dict[str, _RepairHistory] = {}
        self._was_failing: set[str] = set()
        self.last: list[Outcome] = []

    async def run(self) -> None:
        await self._clock.sleep(self._first_run)
        while True:
            try:
                await self.run_once()
            except Exception:
                _log.exception("o auto-diagnóstico falhou de forma inesperada")
            await self._clock.sleep(self._interval)

    async def run_once(self, *, repair: bool = True) -> list[Outcome]:
        outcomes = [await self._check(check, repair=repair) for check in self._checks]
        self.last = outcomes
        failed = [outcome for outcome in outcomes if not outcome.result.ok]
        if failed:
            _log.warning(
                "auto-diagnóstico: %d verificações, %d com problema (%s)",
                len(outcomes),
                len(failed),
                ", ".join(outcome.name for outcome in failed),
            )
        else:
            _log.info("auto-diagnóstico: %d verificações, tudo certo", len(outcomes))
        return outcomes

    async def _run_check(self, check: Check) -> CheckResult:
        try:
            return await check.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log.exception("a verificação %s falhou", check.name, extra={"recorded": True})
            return CheckResult(False, f"a verificação não pôde rodar ({type(exc).__name__})")

    async def _check(self, check: Check, *, repair: bool) -> Outcome:
        result = await self._run_check(check)
        if result.ok:
            if check.name in self._was_failing:
                self._was_failing.discard(check.name)
                _log.info("auto-diagnóstico: %s voltou ao normal (%s)", check.name, result.detail)
            return Outcome(check.name, result)
        self._was_failing.add(check.name)
        _log.warning("auto-diagnóstico: %s: %s", check.name, result.detail)
        severity = result.severity
        self._recorder.record(
            "check.failed",
            severity,
            f"{check.name}: {result.detail}",
            component=component_safe(check.name),
        )
        outcome = Outcome(check.name, result)
        if repair and result.fixable and check.repair is not None and self._may_repair(check.name):
            outcome = await self._repair(check, result)
        if not outcome.result.ok and outcome.result.critical and self._on_critical is not None:
            await self._on_critical(outcome)
        return outcome

    def _may_repair(self, name: str) -> bool:
        history = self._history.setdefault(name, _RepairHistory())
        now = self._clock.monotonic()
        if history.last is not None and now - history.last < self._cooldown:
            return False
        history.attempts = [moment for moment in history.attempts if now - moment < _DAY_SECONDS]
        return len(history.attempts) < MAX_REPAIRS_PER_DAY

    async def _repair(self, check: Check, result: CheckResult) -> Outcome:
        assert check.repair is not None  # noqa: S101 - garantido por quem chama
        history = self._history[check.name]
        now = self._clock.monotonic()
        history.last = now
        history.attempts.append(now)
        label = check.repair_label or "reparo"
        component = component_safe(check.name)
        try:
            error = await check.repair()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log.exception("o reparo de %s falhou", check.name, extra={"recorded": True})
            self._recorder.record(
                "repair.failed",
                "warn",
                f"{check.name}: {label} falhou",
                component=component,
                error=exc,
            )
            return Outcome(check.name, result, repair_error=type(exc).__name__)
        if error is not None:
            _log.warning("auto-reparo de %s não resolveu: %s", check.name, error)
            self._recorder.record(
                "repair.failed", "warn", f"{check.name}: {label} não resolveu", component=component
            )
            return Outcome(check.name, result, repair_error=error)
        after = await self._run_check(check)
        if after.ok:
            _log.info("auto-reparo de %s: %s", check.name, label)
            self._recorder.record(
                "repair.done", "info", f"{check.name}: {label}", component=component
            )
            self._was_failing.discard(check.name)
            return Outcome(check.name, after, repaired=True)
        _log.warning(
            "auto-reparo de %s feito, mas o problema continua: %s", check.name, after.detail
        )
        self._recorder.record(
            "repair.failed",
            "warn",
            f"{check.name}: {label} feito, mas o problema continua",
            component=component,
        )
        return Outcome(check.name, after, repair_error="o problema continua")
