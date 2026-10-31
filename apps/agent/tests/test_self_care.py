"""Auto-diagnóstico: quando reparar, o que cada verificação confere e o reparo seguro."""

import asyncio
from collections import namedtuple
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tests.test_diagnostics import MemoryStore
from uniover_agent.adapters import self_care_checks as checks_module
from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.adapters.self_care_checks import (
    CONNECTION_GRACE_SECONDS,
    RESTART_SPACING_SECONDS,
    SUPERVISOR_SILENCE_SECONDS,
    ConnectionWatch,
    TaskState,
    api_check,
    background_tasks_check,
    connection_check,
    installation_check,
    startup_task_check,
    supervisor_check,
    tv_check,
)
from uniover_agent.core.diagnostics import DiagnosticsRecorder
from uniover_agent.core.self_care import (
    MAX_REPAIRS_PER_DAY,
    Check,
    CheckResult,
    Outcome,
    SelfCare,
)
from uniover_agent.core.supervision import TaskHealth

VERSION = "a" * 40
OK = CheckResult(True, "tudo certo")


def care(
    checks: list[Check], clock: FakeClock | None = None, **kwargs: object
) -> tuple[SelfCare, MemoryStore, FakeClock]:
    time = clock or FakeClock(datetime(2026, 10, 31, 12, 0, tzinfo=UTC))
    store = MemoryStore()
    recorder = DiagnosticsRecorder(store, FakeClock(datetime(2026, 10, 31, tzinfo=UTC)))
    return SelfCare(checks, recorder, time, **kwargs), store, time  # type: ignore[arg-type]


class Broken:
    """Uma verificação que falha até o reparo rodar (ou nunca, se `fixes` for falso)."""

    def __init__(self, *, fixes: bool = True, repair_error: str | None = None) -> None:
        self.fixes = fixes
        self.repaired = 0
        self.broken = True
        self.repair_error = repair_error

    async def run(self) -> CheckResult:
        return CheckResult(False, "quebrado", fixable=True) if self.broken else OK

    async def repair(self) -> str | None:
        self.repaired += 1
        if self.fixes and self.repair_error is None:
            self.broken = False
        return self.repair_error

    def check(self) -> Check:
        return Check("peca", self.run, self.repair, "peça refeita")


# --- núcleo -------------------------------------------------------------------------------------


async def test_a_failing_check_is_repaired_confirmed_and_both_are_recorded() -> None:
    broken = Broken()
    sc, store, _ = care([broken.check()])
    [outcome] = await sc.run_once()
    assert outcome.repaired and outcome.result.ok
    assert [(e.kind, e.severity) for e in store.events] == [
        ("check.failed", "error"),
        ("repair.done", "info"),
    ]
    assert broken.repaired == 1


async def test_a_repair_only_runs_when_asked_to() -> None:
    broken = Broken()
    sc, store, _ = care([broken.check()])
    [outcome] = await sc.run_once(repair=False)
    assert not outcome.result.ok and broken.repaired == 0
    assert [e.kind for e in store.events] == ["check.failed"]


async def test_a_repair_that_does_not_solve_is_reported_and_waits_before_trying_again() -> None:
    broken = Broken(fixes=False)
    sc, store, clock = care([broken.check()], cooldown=1800)
    [first] = await sc.run_once()
    assert first.repair_error == "o problema continua"
    await sc.run_once()
    assert broken.repaired == 1  # dentro da espera, não tenta de novo
    clock.advance(1801)
    await sc.run_once()
    assert broken.repaired == 2
    assert "repair.failed" in [e.kind for e in store.events]


async def test_a_repair_that_reports_an_error_is_not_confirmed() -> None:
    broken = Broken(repair_error="o Agendador não aceitou")
    sc, store, _ = care([broken.check()])
    [outcome] = await sc.run_once()
    assert not outcome.repaired and outcome.repair_error == "o Agendador não aceitou"
    assert [e.kind for e in store.events] == ["check.failed", "repair.failed"]


async def test_a_repair_that_raises_is_contained() -> None:
    async def run() -> CheckResult:
        return CheckResult(False, "quebrado", fixable=True)

    async def repair() -> str | None:
        raise OSError("disco")

    sc, store, _ = care([Check("peca", run, repair, "refeita")])
    [outcome] = await sc.run_once()
    assert outcome.repair_error == "OSError"
    assert "repair.failed" in [e.kind for e in store.events]


async def test_the_daily_cap_stops_a_repair_that_never_works() -> None:
    broken = Broken(fixes=False)
    sc, _, clock = care([broken.check()], cooldown=0)
    for _ in range(MAX_REPAIRS_PER_DAY + 3):
        await sc.run_once()
        clock.advance(60)
    assert broken.repaired == MAX_REPAIRS_PER_DAY
    clock.advance(24 * 3600)
    await sc.run_once()
    assert broken.repaired == MAX_REPAIRS_PER_DAY + 1


async def test_a_check_that_raises_becomes_a_failure_not_a_crash() -> None:
    async def run() -> CheckResult:
        raise RuntimeError("segredo")

    sc, store, _ = care([Check("fragil", run)])
    [outcome] = await sc.run_once()
    assert not outcome.result.ok and "RuntimeError" in outcome.result.detail
    assert "segredo" not in store.events[0].detail


async def test_a_warning_is_recorded_as_a_warning_and_is_never_repaired() -> None:
    async def run() -> CheckResult:
        return CheckResult(False, "TV fora", severity="warn")

    sc, store, _ = care([Check("tv", run)])
    await sc.run_once()
    assert [(e.kind, e.severity) for e in store.events] == [("check.failed", "warn")]


async def test_a_critical_failure_that_stays_is_handed_to_the_critical_callback() -> None:
    seen: list[Outcome] = []

    async def on_critical(outcome: Outcome) -> None:
        seen.append(outcome)

    async def run() -> CheckResult:
        return CheckResult(False, "pasta incompleta", critical=True)

    sc, _, _ = care([Check("instalacao", run)], on_critical=on_critical)
    await sc.run_once()
    assert [o.name for o in seen] == ["instalacao"]


async def test_a_critical_failure_that_the_repair_fixes_is_not_reported_as_critical() -> None:
    seen: list[Outcome] = []
    state = {"broken": True}

    async def on_critical(outcome: Outcome) -> None:
        seen.append(outcome)

    async def run() -> CheckResult:
        if state["broken"]:
            return CheckResult(False, "x", fixable=True, critical=True)
        return OK

    async def repair() -> str | None:
        state["broken"] = False
        return None

    sc, _, _ = care([Check("p", run, repair)], on_critical=on_critical)
    await sc.run_once()
    assert seen == []


async def test_the_background_loop_waits_then_checks_every_interval() -> None:
    broken = Broken(fixes=False)
    sc, _, clock = care([broken.check()], interval=600, first_run=90, cooldown=10**9)
    task = asyncio.create_task(sc.run())
    for _ in range(30):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert clock.sleeps[:2] == [90, 600]


# --- instalação ---------------------------------------------------------------------------------

DiskUsage = namedtuple("DiskUsage", "total used free")


def healthy_install(root: Path) -> None:
    for name in ("runtime", "config", "logs", "web", "icons"):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "app" / "tools").mkdir(parents=True, exist_ok=True)
    (root / "app" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (root / "app" / "tools" / "run-agent.ps1").write_text("# x\n", encoding="ascii")
    (root / "app" / ".version").write_text(VERSION + "\n", encoding="ascii")


def disk(monkeypatch: pytest.MonkeyPatch, free_mb: int) -> None:
    monkeypatch.setattr(
        "shutil.disk_usage",
        lambda path: DiskUsage(10**12, 10**12 - free_mb * 2**20, free_mb * 2**20),
    )


async def test_a_healthy_installation_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    healthy_install(tmp_path)
    disk(monkeypatch, 50_000)
    result = await installation_check(tmp_path).run()
    assert result.ok, result.detail


async def test_missing_folders_are_fixable_and_the_repair_recreates_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    healthy_install(tmp_path)
    disk(monkeypatch, 50_000)
    (tmp_path / "logs").rmdir()
    (tmp_path / "web").rmdir()
    check = installation_check(tmp_path)
    result = await check.run()
    assert not result.ok and result.fixable and "logs" in result.detail and "web" in result.detail
    assert check.repair is not None
    assert await check.repair() is None
    assert (await check.run()).ok


async def test_an_incomplete_app_folder_is_critical_and_not_fixable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    healthy_install(tmp_path)
    disk(monkeypatch, 50_000)
    (tmp_path / "app" / "tools" / "run-agent.ps1").unlink()
    result = await installation_check(tmp_path).run()
    assert not result.ok and result.critical and not result.fixable
    healthy_install(tmp_path)
    (tmp_path / "app" / ".version").write_text("curta\n", encoding="ascii")
    result = await installation_check(tmp_path).run()
    assert not result.ok and result.critical and "marca da versão" in result.detail


@pytest.mark.parametrize(
    ("free_mb", "expected"),
    [
        (50_000, (True, "error", False)),
        (500, (False, "warn", False)),
        (50, (False, "error", True)),
    ],
)
async def test_low_disk_space_is_a_warning_and_very_low_is_an_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    free_mb: int,
    expected: tuple[bool, str, bool],
) -> None:
    healthy_install(tmp_path)
    disk(monkeypatch, free_mb)
    result = await installation_check(tmp_path).run()
    ok = expected[0]
    assert (result.ok, result.severity, result.fixable) == expected
    if not ok:
        assert f"{free_mb} MB" in result.detail


# --- supervisor ---------------------------------------------------------------------------------


def starter(started: list[str]) -> Callable[[str], bool]:
    def start(name: str) -> bool:
        started.append(name)
        return True

    return start


async def test_the_supervisor_is_alive_when_its_sign_is_recent(tmp_path: Path) -> None:
    alive = tmp_path / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    started: list[str] = []
    now = alive.stat().st_mtime + 60
    check = supervisor_check(
        tmp_path,
        name="teste",
        now=lambda: now,
        start_task=starter(started),
    )
    assert (await check.run()).ok
    assert started == []


async def test_a_silent_supervisor_is_fixable_by_starting_the_task_again(tmp_path: Path) -> None:
    alive = tmp_path / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    now = alive.stat().st_mtime + SUPERVISOR_SILENCE_SECONDS + 60
    started: list[str] = []
    check = supervisor_check(
        tmp_path,
        name="teste",
        now=lambda: now,
        start_task=starter(started),
    )
    result = await check.run()
    assert not result.ok and result.fixable and "mudo" in result.detail
    assert check.repair is not None and await check.repair() is None
    assert started == ["teste"]


async def test_a_supervisor_that_never_signalled_is_a_failure_and_a_failed_start_is_reported(
    tmp_path: Path,
) -> None:
    check = supervisor_check(tmp_path, name="teste", start_task=lambda name: False)
    result = await check.run()
    assert not result.ok and "nunca" in result.detail
    assert check.repair is not None
    assert "não consegui" in str(await check.repair())


# --- conexão ------------------------------------------------------------------------------------


class Reach:
    def __init__(self, answer: bool) -> None:
        self.answer = answer

    async def __call__(self) -> bool:
        return self.answer


def connection(
    tmp_path: Path, answer: bool, *, restarts: list[str] | None = None
) -> tuple[Check, ConnectionWatch, list[float]]:
    moment = [0.0]
    watch = ConnectionWatch(lambda: moment[0])
    wall = [10**9]
    check = connection_check(
        watch,
        Reach(answer),
        request_restart=(lambda: restarts.append("restart")) if restarts is not None else None,
        restarts_marker=tmp_path / "marca.txt",
        now=lambda: wall[0],
    )
    return check, watch, moment


async def test_connected_or_briefly_disconnected_is_fine(tmp_path: Path) -> None:
    check, watch, moment = connection(tmp_path, answer=False)
    watch.connected_now()
    assert (await check.run()).detail == "conectado"
    watch.disconnected_now()
    moment[0] = CONNECTION_GRACE_SECONDS - 1
    result = await check.run()
    assert result.ok and result.detail == "reconectando"


async def test_a_long_outage_with_the_api_down_is_a_warning_without_repair(tmp_path: Path) -> None:
    check, watch, moment = connection(tmp_path, answer=False, restarts=[])
    watch.disconnected_now()
    moment[0] = CONNECTION_GRACE_SECONDS + 1
    result = await check.run()
    assert (result.ok, result.severity, result.fixable) == (False, "warn", False)
    assert "a API não responde" in result.detail


async def test_a_long_outage_with_the_api_up_asks_the_supervisor_to_restart_but_not_twice_in_3h(
    tmp_path: Path,
) -> None:
    restarts: list[str] = []
    check, watch, moment = connection(tmp_path, answer=True, restarts=restarts)
    watch.disconnected_now()
    moment[0] = CONNECTION_GRACE_SECONDS + 1
    result = await check.run()
    assert not result.ok and result.fixable and "a API responde" in result.detail
    assert check.repair is not None and await check.repair() is None
    assert restarts == ["restart"]
    # Logo depois do pedido, não é mais "reparável": o marcador segura um segundo reinício.
    marker = tmp_path / "marca.txt"
    now = marker.stat().st_mtime
    again = connection_check(
        watch,
        Reach(True),
        request_restart=lambda: None,
        restarts_marker=marker,
        now=lambda: now + 60,
    )
    assert not (await again.run()).fixable
    later = connection_check(
        watch,
        Reach(True),
        request_restart=lambda: None,
        restarts_marker=marker,
        now=lambda: now + RESTART_SPACING_SECONDS + 1,
    )
    assert (await later.run()).fixable


async def test_without_a_supervisor_there_is_nothing_to_ask_for_a_restart(tmp_path: Path) -> None:
    check, watch, moment = connection(tmp_path, answer=True, restarts=None)
    watch.disconnected_now()
    moment[0] = CONNECTION_GRACE_SECONDS + 1
    assert not (await check.run()).fixable
    assert check.repair is not None
    assert "sem supervisor" in str(await check.repair())


def test_the_connection_watch_counts_from_the_first_drop() -> None:
    moment = [100.0]
    watch = ConnectionWatch(lambda: moment[0])
    assert watch.seconds_down() == 0.0  # ainda não houve queda registrada: conta desde agora
    moment[0] = 160.0
    assert watch.seconds_down() == 60.0
    watch.connected_now()
    assert watch.seconds_down() == 0.0
    moment[0] = 200.0
    watch.disconnected_now()
    moment[0] = 230.0
    watch.disconnected_now()  # outra notificação de queda não reinicia a conta
    assert watch.seconds_down() == 30.0


# --- TV, tarefas, API ---------------------------------------------------------------------------


async def test_a_tv_that_does_not_answer_only_warns_after_several_checks() -> None:
    check = tv_check(Reach(False))
    results = [await check.run() for _ in range(3)]
    assert [r.ok for r in results] == [True, True, False]
    assert results[2].severity == "warn"
    answering = tv_check(Reach(True))
    assert (await answering.run()).detail == "TV alcançável"


async def test_the_tv_counter_starts_over_when_it_answers() -> None:
    answers = [False, False, True, False, False]
    index = [0]

    async def reachable() -> bool:
        index[0] += 1
        return answers[index[0] - 1]

    check = tv_check(reachable)
    assert all([(await check.run()).ok for _ in answers])


async def test_background_tasks_that_keep_failing_are_listed() -> None:
    clock = FakeClock()
    health = TaskHealth(clock)
    check = background_tasks_check(health)
    health.note_failure("tv.watch")
    health.note_failure("tv.watch")
    assert (await check.run()).ok
    health.note_failure("tv.watch")
    health.note_failure("outra")
    result = await check.run()
    assert not result.ok and "tv.watch (3 vezes)" in result.detail and "outra" not in result.detail


async def test_the_api_check_warns_without_blocking() -> None:
    assert (await api_check(Reach(True)).run()).ok
    result = await api_check(Reach(False)).run()
    assert (result.ok, result.severity) == (False, "warn")


# --- tarefa de início automático (com o Agendador de mentira) -----------------------------------


@pytest.fixture
def anchor(tmp_path: Path) -> Path:
    folder = tmp_path / "ancora"
    folder.mkdir()
    (folder / "launcher.ps1").write_text("# l\n", encoding="ascii")
    (folder / "launcher.vbs").write_text("' v\n", encoding="ascii")
    return folder


def good_state(anchor: Path) -> TaskState:
    return TaskState(
        True,
        True,
        r"C:\Windows\System32\wscript.exe",
        f'//B //Nologo "{anchor / "launcher.vbs"}"',
        2,
    )


def task_check(
    anchor: Path,
    tmp_path: Path,
    state: TaskState | None,
    registered: list[tuple[Path, Path, str]] | None = None,
    accepts: bool = True,
) -> Check:
    def register(anchor_dir: Path, root: Path, name: str) -> bool:
        if registered is not None:
            registered.append((anchor_dir, root, name))
        return accepts

    return startup_task_check(
        tmp_path / "dados", anchor, name="teste", query=lambda name: state, register=register
    )


async def test_a_good_task_passes_and_an_unreadable_scheduler_is_not_a_failure(
    anchor: Path, tmp_path: Path
) -> None:
    assert (await task_check(anchor, tmp_path, good_state(anchor)).run()).ok
    assert (await task_check(anchor, tmp_path, None).run()).ok


@pytest.mark.parametrize(
    ("state", "word"),
    [
        (TaskState(False), "não existe"),
        (TaskState(True, False, "wscript.exe", "launcher.vbs", 2), "desativada"),
        (TaskState(True, True, r"C:\x\outro.exe", "qualquer", 2), "não aponta"),
        (
            TaskState(True, True, r"C:\Windows\System32\wscript.exe", "//B outro.vbs", 2),
            "não aponta",
        ),
    ],
)
async def test_a_task_that_is_missing_disabled_or_pointing_elsewhere_is_fixable(
    anchor: Path, tmp_path: Path, state: TaskState, word: str
) -> None:
    result = await task_check(anchor, tmp_path, state).run()
    assert not result.ok and result.fixable and word in result.detail


async def test_a_task_without_a_trigger_is_fixable(anchor: Path, tmp_path: Path) -> None:
    state = good_state(anchor)
    state = TaskState(state.present, state.enabled, state.execute, state.arguments, 0)
    result = await task_check(anchor, tmp_path, state).run()
    assert not result.ok and "gatilho" in result.detail


async def test_missing_launcher_files_are_found_and_restored_from_the_app_folder_by_the_repair(
    anchor: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks_module, "_powershell_run", lambda *args, **kwargs: None)
    (anchor / "launcher.ps1").unlink()
    (anchor / "launcher.vbs").unlink()
    root = tmp_path / "dados"
    (root / "app" / "tools").mkdir(parents=True)
    (root / "app" / "tools" / "launcher.ps1").write_text("# do app\n", encoding="ascii")
    registered: list[tuple[Path, Path, str]] = []
    check = task_check(anchor, tmp_path, good_state(anchor), registered)
    result = await check.run()
    assert not result.ok and result.fixable and "launcher.ps1" in result.detail
    assert check.repair is not None and await check.repair() is None
    assert (anchor / "launcher.ps1").read_text(encoding="ascii") == "# do app\n"
    # O `.vbs` o registro regrava; a cópia só vale para o que o `app` traz.
    assert registered == [(anchor, root, "teste")]


async def test_the_repair_says_so_when_the_scheduler_refuses(
    anchor: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks_module, "_powershell_run", lambda *args, **kwargs: None)
    check = task_check(anchor, tmp_path, TaskState(False), accepts=False)
    assert check.repair is not None
    assert "não aceitou" in str(await check.repair())
