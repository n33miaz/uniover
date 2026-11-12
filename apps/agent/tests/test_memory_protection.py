"""O agente fica na memória e na vez: prioridades devolvidas ao normal, mínimo duro e o aviso.

Medido em 12/11 no PC do dono: a tarefa agendada (prioridade 7) deixa lançador, supervisor e agente
com CPU abaixo do normal, memória 2 e E/S 1; sob pouca memória o laço parou até 189 s.
"""

import asyncio
import gc
import importlib.util
import logging
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from uniover_agent.adapters import crash_trace, windows_scheduling
from uniover_agent.adapters.loop_lag import LoopLagMonitor
from uniover_agent.adapters.process_memory import MemoryCounters

MB = 1024 * 1024
TOOL = Path(__file__).resolve().parents[1] / "tools" / "check_memory_protection.py"
# O `conftest` troca as funções que mexem no processo; a bancada usa as de verdade num filho.
REAL_RESTORE = windows_scheduling.restore_normal_priority
REAL_KEEP = windows_scheduling.keep_agent_responsive


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_memory_protection", TOOL)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_memory_protection"] = module
    spec.loader.exec_module(module)
    return module


# ---- quem vigia o agente: os ancestrais PowerShell -------------------------------------------


def test_the_launcher_and_the_supervisor_are_found_up_the_chain() -> None:
    # A cadeia medida no PC do dono: python -> python (venv) -> uniover-agent.exe -> uv.exe ->
    # powershell (supervisor) -> powershell (lançador) -> wscript.
    table = {
        11020: (2184, "python.exe"),
        2184: (11092, "python.exe"),
        11092: (6340, "uniover-agent.exe"),
        6340: (26608, "uv.exe"),
        26608: (15824, "powershell.exe"),
        15824: (900, "PowerShell.EXE"),
        900: (4, "wscript.exe"),
    }
    assert windows_scheduling.walk_ancestors(table, 11020) == [26608, 15824]


def test_the_walk_stops_at_a_dead_parent_and_at_a_cycle() -> None:
    # O pai já saiu: nada acima dele é procurado (o pid pode ser de outro programa).
    assert windows_scheduling.walk_ancestors({10: (20, "python.exe")}, 10) == []
    # Pid reaproveitado formando ciclo: termina sem repetir.
    cycle = {10: (20, "python.exe"), 20: (30, "powershell.exe"), 30: (20, "powershell.exe")}
    assert windows_scheduling.walk_ancestors(cycle, 10) == [20, 30]


def test_a_priority_result_says_what_changed() -> None:
    nothing = windows_scheduling.PriorityResult((), ())
    assert nothing.describe() == "já estava no normal"
    changed = windows_scheduling.PriorityResult(("memória 2 -> 5", "E/S 1 -> 2"), ())
    assert changed.describe() == "memória 2 -> 5, E/S 1 -> 2"


def test_keep_agent_responsive_logs_each_process_and_refusals(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # Sem tocar em processo nenhum: a tabela e a troca de prioridade são de mentira.
    monkeypatch.setattr(sys, "platform", "win32")
    table = {
        1: (2, "python.exe"),
        2: (3, "powershell.exe"),
        3: (4, "powershell.exe"),
        4: (0, "explorer.exe"),
    }
    monkeypatch.setattr(windows_scheduling, "process_table", lambda: table)
    monkeypatch.setattr("os.getpid", lambda: 1)
    # Só o supervisor (2) se declarou; o 3 é um PowerShell que ninguém declarou (o da pessoa).
    monkeypatch.setenv("UNIOVER_SUPERVISOR_PROCESS", "2:133000000000000000")
    monkeypatch.delenv("UNIOVER_LAUNCHER_PROCESS", raising=False)
    seen: list[tuple[int | None, int | None]] = []

    def fake_restore(
        pid: int | None = None, created: int | None = None
    ) -> windows_scheduling.PriorityResult:
        seen.append((pid, created))
        if pid is None:
            return windows_scheduling.PriorityResult(("CPU abaixo do normal -> normal",), ())
        return windows_scheduling.PriorityResult((), ("E/S (status 0xc0000061)",))

    monkeypatch.setattr(windows_scheduling, "restore_normal_priority", fake_restore)
    with caplog.at_level(logging.DEBUG, logger="uniover_agent.adapters.windows_scheduling"):
        REAL_KEEP()

    assert seen == [(None, None), (2, 133000000000000000)]
    assert "ancestral 3 não se declarou" in caplog.text
    text = caplog.text
    assert "prioridade do agente: CPU abaixo do normal -> normal" in text
    assert "lançador/supervisor (pid 2)" in text
    assert "recusou parte da prioridade" in text and "sigo assim" in text


def test_the_declared_watchers_are_read_from_the_environment() -> None:
    environ = {
        "UNIOVER_LAUNCHER_PROCESS": "15824:134389791486871076",
        "UNIOVER_SUPERVISOR_PROCESS": " 26608:134389791500000000 ",
    }
    assert windows_scheduling.declared_watchers(environ) == {
        15824: 134389791486871076,
        26608: 134389791500000000,
    }
    # Ausente ou malformado: ninguém declarado.
    assert windows_scheduling.declared_watchers({}) == {}
    assert windows_scheduling.declared_watchers({"UNIOVER_LAUNCHER_PROCESS": "15824"}) == {}
    assert windows_scheduling.declared_watchers({"UNIOVER_LAUNCHER_PROCESS": "x:1"}) == {}


class _FailingKernel32:
    """Toda leitura de prioridade falha (como um handle sem o direito de consulta)."""

    def GetPriorityClass(self, handle: Any) -> int:  # noqa: N802 - nome da API
        return 0

    def GetProcessInformation(self, *args: Any) -> bool:  # noqa: N802
        return False


class _FailingNtdll:
    def NtQueryInformationProcess(self, *args: Any) -> int:  # noqa: N802
        return -1073741790  # STATUS_ACCESS_DENIED (0xc0000022)


def test_a_priority_that_cannot_be_read_is_a_refusal_not_normal() -> None:
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    api = (ctypes, wintypes, _FailingKernel32(), _FailingNtdll())
    cpu = windows_scheduling._raise_cpu_priority(api, None)
    memory = windows_scheduling._raise_memory_priority(api, None)
    io = windows_scheduling._raise_io_priority(api, None)
    assert isinstance(cpu, windows_scheduling._Refused)
    assert cpu.detail.startswith("leitura, erro ")
    assert isinstance(memory, windows_scheduling._Refused)
    assert memory.detail.startswith("leitura, erro ")
    assert io == windows_scheduling._Refused("leitura, status 0xc0000022")


def test_outside_windows_nothing_is_touched(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    assert REAL_RESTORE() is None
    assert windows_scheduling.read_priorities() is None
    assert windows_scheduling.read_hard_minimum() is None
    assert windows_scheduling.process_table() == {}


# ---- a bancada, num processo filho (nunca no processo de teste) -----------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="só no Windows")
def test_the_bench_child_gets_normal_priorities_and_the_hard_minimum() -> None:
    tool = load_tool()
    measured = tool.run_child(16)

    # Nasceu como a tarefa agendada deixa e saiu no normal.
    assert measured["before"][0] == 0x4000
    assert measured["before"][1:] == [2, 1]
    assert tool.verdict(measured, 16) == []
    assert "memória 2 -> 5" in measured["changes"]
    assert "E/S 1 -> 2" in measured["changes"]
    assert "EcoQoS desligado" in measured["changes"]
    assert measured["failures"] == []
    # A thread principal (a do laço que parou 189 s) acompanha o processo.
    assert measured["main_thread_before"] == [2, 1]
    assert measured["main_thread_after"] == [5, 2]


@pytest.mark.skipif(sys.platform != "win32", reason="só no Windows")
def test_another_process_is_raised_by_pid_like_the_launcher_and_the_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A função de verdade, mas só sobre o filho que a bancada abre (nunca o processo de teste).
    monkeypatch.setattr(windows_scheduling, "restore_normal_priority", REAL_RESTORE)
    tool = load_tool()
    crossed = tool.cross_process()

    assert crossed["before"] == [0x4000, 2, 1]
    assert crossed["after"] == [0x20, 5, 2]
    assert crossed["failures"] == []


@pytest.mark.skipif(sys.platform != "win32", reason="só no Windows")
def test_only_the_process_born_at_the_declared_time_is_touched() -> None:
    # Um PowerShell filho declara-se como o lançador e o supervisor fazem (mesma expressão).
    import subprocess  # noqa: PLC0415

    script = (
        "$p = [System.Diagnostics.Process]::GetCurrentProcess();"
        " [Console]::Out.WriteLine(([string]$PID) + ':' + $p.StartTime.ToFileTimeUtc());"
        " [Console]::Out.Flush(); [void][Console]::In.ReadLine()"
    )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
        subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0
    )
    child = subprocess.Popen(  # noqa: S603 - o PowerShell do sistema e um script fixo
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],  # noqa: S607
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        creationflags=flags,
    )
    try:
        assert child.stdout is not None
        declared = windows_scheduling.declared_watchers(
            {"UNIOVER_LAUNCHER_PROCESS": child.stdout.readline().strip()}
        )
        assert list(declared) == [child.pid]
        created = declared[child.pid]
        # Outra hora de criação (um pid reaproveitado): nada é tocado.
        assert REAL_RESTORE(child.pid, created + 1) is None
        # A hora declarada pelo próprio PowerShell bate com a do Windows, até os 100 ns.
        result = REAL_RESTORE(child.pid, created)
        assert result is not None
        assert "CPU abaixo do normal -> normal" in result.changes
        assert result.failures == ()
    finally:
        assert child.stdin is not None
        child.stdin.write("\n")
        child.stdin.flush()
        child.wait(timeout=30)


# ---- o aviso de que o agente foi tirado da memória ------------------------------------------


def _monitor(samples: list[int], floor: int, clock: list[float]) -> LoopLagMonitor:
    feed = iter(MemoryCounters(1_000 + index, size) for index, size in enumerate(samples))
    times = iter(clock)
    return LoopLagMonitor(
        memory=lambda: next(feed),
        monotonic=lambda: next(times),
        working_set_floor=floor,
        floor_repeat=600.0,
    )


def test_a_working_set_below_the_floor_is_warned_once_and_again_later(
    caplog: pytest.LogCaptureFixture,
) -> None:
    monitor = _monitor([60 * MB, 9 * MB, 10 * MB, 8 * MB, 40 * MB], 32 * MB, [0, 60, 120, 700, 760])
    with caplog.at_level(logging.INFO):
        for _ in range(5):
            monitor.report()

    warnings = [r.message for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2, warnings  # ao cair (60 s) e depois do intervalo (700 s)
    assert "conjunto de trabalho 9 MB, abaixo do esperado (32 MB)" in warnings[0]
    assert "falhas de página +1 no minuto" in warnings[0]
    back = [r.message for r in caplog.records if "de volta" in r.message]
    assert back == [
        "conjunto de trabalho do agente de volta a 40 MB (ficou abaixo de 32 MB por 700 s)"
    ]


def test_without_a_floor_there_is_no_warning(caplog: pytest.LogCaptureFixture) -> None:
    monitor = _monitor([60 * MB, 3 * MB], 0, [0, 60])
    with caplog.at_level(logging.INFO):
        monitor.report()
        monitor.report()
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


# ---- os erros depois da parada ----------------------------------------------------------------


class _Recorder:
    def __init__(self) -> None:
        self.kinds: list[str] = []

    def record(self, kind: str, *args: Any, **kwargs: Any) -> None:
        self.kinds.append(kind)


def _proactor_transport() -> Any:
    from asyncio import proactor_events  # noqa: PLC0415

    class _Unopened(proactor_events._ProactorSocketTransport):
        def __del__(self) -> None:  # nunca aberto: nada a fechar
            pass

    # Sem soquete nem laço: só para ter o método de verdade (herdado) preso a uma instância.
    return object.__new__(_Unopened)


def test_only_the_asyncio_proactor_reset_is_benign() -> None:
    class _ProactorBasePipeTransport:
        def _call_connection_lost(self, exc: BaseException | None) -> None: ...

    loop = asyncio.new_event_loop()
    try:
        real = asyncio.Handle(_proactor_transport()._call_connection_lost, (None,), loop)
        impostor = asyncio.Handle(_ProactorBasePipeTransport()._call_connection_lost, (None,), loop)
        reset = ConnectionResetError(10054, "reset")
        benign = crash_trace.is_benign_proactor_reset
        assert benign({"exception": reset, "handle": real})
        # Mesmo nome, outro módulo: continua erro.
        assert not benign({"exception": reset, "handle": impostor})
        # O callback certo com outro código (10053, conexão abortada): continua erro.
        assert not benign({"exception": ConnectionResetError(10053, "aborted"), "handle": real})
        # Só a mensagem com o nome, sem o handle: continua erro.
        message = "Exception in callback _ProactorBasePipeTransport._call_connection_lost()"
        assert not benign({"exception": reset, "message": message})
    finally:
        loop.close()


def test_the_proactor_reset_after_the_peer_left_is_not_an_agent_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    loop = asyncio.new_event_loop()
    try:
        handle = asyncio.Handle(_proactor_transport()._call_connection_lost, (None,), loop)
        recorder = _Recorder()
        handler = crash_trace.loop_exception_handler(recorder)  # type: ignore[arg-type]
        with caplog.at_level(logging.INFO):
            handler(
                loop,
                {
                    "message": "Exception in callback "
                    "_ProactorBasePipeTransport._call_connection_lost()",
                    "exception": ConnectionResetError(10054, "reset"),
                    "handle": handle,
                },
            )
            # Qualquer outro erro no laço continua erro.
            handler(loop, {"message": "outra coisa", "exception": ValueError("x")})
    finally:
        loop.close()

    assert recorder.kinds == ["loop.error"]
    assert [r.levelno for r in caplog.records] == [logging.INFO, logging.ERROR]


def test_a_task_destroyed_while_pending_names_the_task(caplog: pytest.LogCaptureFixture) -> None:
    async def nunca_termina() -> None:
        await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    recorder = _Recorder()
    loop.set_exception_handler(crash_trace.loop_exception_handler(recorder))  # type: ignore[arg-type]
    try:
        with caplog.at_level(logging.ERROR):
            loop.run_until_complete(_drop_a_pending_task(nunca_termina))
            gc.collect()
    finally:
        loop.close()

    destroyed = [r.message for r in caplog.records if "destroyed" in r.message]
    assert destroyed, caplog.text
    assert "nunca_termina" in destroyed[0]


async def _drop_a_pending_task(coroutine: Any) -> None:
    asyncio.ensure_future(coroutine())  # noqa: RUF006 - de propósito: a tarefa sem referência
    await asyncio.sleep(0)


def test_the_device_notice_without_a_waiter_keeps_its_task_alive() -> None:
    # `_announce_device` sem envio entre laços: a tarefa do aviso precisa sobreviver a uma coleta.
    from uniover_agent.composition import pc  # noqa: PLC0415

    sent: list[dict[str, Any]] = []
    gate = asyncio.Event()

    async def send(envelope: dict[str, Any]) -> None:
        await gate.wait()
        sent.append(envelope)

    async def scenario() -> None:
        setup = object.__new__(pc.PcSetup)
        setup._device_envelope = lambda device_id, state: {"id": device_id, "state": state}
        setup._device_fire = None
        setup._device_send = send
        setup._announce_device("abc", "approved")
        await asyncio.sleep(0)
        gc.collect()
        gate.set()
        for _ in range(5):
            await asyncio.sleep(0)

    asyncio.run(scenario())
    assert sent == [{"id": "abc", "state": "approved"}]
    assert not pc._DETACHED
