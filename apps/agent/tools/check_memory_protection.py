r"""Bancada: as proteções de memória e prioridade do agente funcionam NESTE PC?

Abre um processo filho do Python já com a prioridade da tarefa agendada (CPU abaixo do normal,
memória 2, E/S 1), aplica nele exatamente o que o agente aplica na partida
(`restore_normal_priority` e `protect_working_set`) e confere pelo próprio Windows
(`GetProcessWorkingSetSizeEx`, `GetProcessMemoryInfo`, `GetProcessInformation`):

- CPU normal, memória 5, E/S 2;
- o mínimo duro do conjunto de trabalho em vigor (bandeira `QUOTA_LIMITS_HARDWS_MIN_ENABLE`);
- depois de tocar um pouco mais que o mínimo, o conjunto de trabalho fica acima dele;
- e o limite conhecido: um `EmptyWorkingSet` (o que faz um limpador de memória como o Mem Reduct)
  esvazia o processo mesmo com o mínimo duro (só registrado, não é falha da bancada).

Leve de propósito: o filho usa poucas dezenas de MB e não enche a memória do PC. Não mexe em nenhum
outro processo. Uso (na pasta `apps/agent`):

    uv run python tools/check_memory_protection.py [--min-mb 16]

Sai com 0 se tudo o que o agente promete se confirmou; 1 se não; 2 fora do Windows. Também sobe
pelo pid um segundo filho (o caminho do lançador e do supervisor) e confere a thread principal.

Ensaio manual, sem provocar carga (nada de encher a memória de propósito):

1. depois da atualização, no `logs\agent.log`: a linha `prioridade do agente: CPU abaixo do normal
   -> normal, memória 2 -> 5, E/S 1 -> 2, EcoQoS desligado` e uma `prioridade do
   lançador/supervisor (pid N)` para cada PowerShell acima do agente;
2. rodar esta bancada (ok no fim);
3. ler, sem mudar nada, os processos vivos (classe 0x20, memória 5, E/S 2) com
   `GetPriorityClass`, `GetProcessInformation(ProcessMemoryPriority)` e
   `NtQueryInformationProcess(ProcessIoPriority)`;
4. na próxima lentidão real (ou na próxima limpeza do Mem Reduct): o aviso `o agente foi tirado da
   memória` ao lado das linhas `loop_lag`, e no `supervisor.log` o lançador dizendo `o PC ficou
   suspenso` ou `ficou X s sem rodar (memoria/disco)`. O lançador só usa o código novo depois de
   reiniciar (o supervisor troca a cópia da pasta fixa, mas o lançador em execução já leu a antiga).
"""

import argparse
import json
import subprocess
import sys
from typing import Any

_BELOW_NORMAL_PRIORITY_CLASS = 0x4000
_NORMAL_PRIORITY_CLASS = 0x20
_MEGABYTE = 1024 * 1024
_PAGE = 4096


def _lower_like_the_scheduled_task() -> None:
    """Põe o próprio processo como a tarefa agendada o deixa: memória 2 e E/S 1 (baixar é livre)."""
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetProcessInformation.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    ntdll.NtSetInformationProcess.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.ULONG,
    )
    handle = kernel32.GetCurrentProcess()
    low_memory = wintypes.ULONG(2)
    kernel32.SetProcessInformation(handle, 0, ctypes.byref(low_memory), 4)
    low_io = wintypes.ULONG(1)
    ntdll.NtSetInformationProcess(handle, 33, ctypes.byref(low_io), 4)


def thread_priorities() -> tuple[int, int]:
    """(memória, E/S) da thread que chama: as duas também são por thread, e a thread principal
    já existia quando o processo foi devolvido ao normal."""
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.GetCurrentThread.restype = wintypes.HANDLE
    ntdll.NtQueryInformationThread.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.ULONG,
        ctypes.c_void_p,
    )
    thread = kernel32.GetCurrentThread()
    page = wintypes.ULONG(99)
    io = wintypes.ULONG(99)
    ntdll.NtQueryInformationThread(thread, 24, ctypes.byref(page), 4, None)  # ThreadPagePriority
    ntdll.NtQueryInformationThread(thread, 22, ctypes.byref(io), 4, None)  # ThreadIoPriority
    return int(page.value), int(io.value)


def _empty_own_working_set() -> None:
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.K32EmptyWorkingSet.argtypes = (wintypes.HANDLE,)
    kernel32.K32EmptyWorkingSet(kernel32.GetCurrentProcess())


def child(minimum_mb: int) -> dict[str, Any]:
    """O lado do filho: baixa, aplica as proteções do agente e mede."""
    from uniover_agent.adapters import windows_scheduling  # noqa: PLC0415
    from uniover_agent.adapters.process_memory import read_memory_counters  # noqa: PLC0415

    _lower_like_the_scheduled_task()
    thread_before = thread_priorities()
    before = windows_scheduling.read_priorities()
    result = windows_scheduling.restore_normal_priority()
    protected = windows_scheduling.protect_working_set(minimum_mb)
    after = windows_scheduling.read_priorities()
    thread_after = thread_priorities()
    hard_minimum = windows_scheduling.read_hard_minimum()
    buffer = bytearray((minimum_mb + 8) * _MEGABYTE)
    for offset in range(0, len(buffer), _PAGE):
        buffer[offset] = 1
    touched = read_memory_counters()
    _empty_own_working_set()
    emptied = read_memory_counters()
    return {
        "before": before,
        "after": after,
        "main_thread_before": thread_before,
        "main_thread_after": thread_after,
        "changes": list(result.changes) if result else [],
        "failures": list(result.failures) if result else [],
        "protected": protected,
        "hard_minimum_mb": None if hard_minimum is None else hard_minimum // _MEGABYTE,
        "working_set_after_touch_mb": touched.working_set_bytes // _MEGABYTE if touched else None,
        "working_set_after_empty_mb": emptied.working_set_bytes // _MEGABYTE if emptied else None,
    }


def run_child(minimum_mb: int) -> dict[str, Any]:
    """Roda `child` num processo novo, nascido com a CPU abaixo do normal; devolve o medido."""
    completed = subprocess.run(  # noqa: S603 - o próprio Python e este arquivo
        [sys.executable, __file__, "--child", "--min-mb", str(minimum_mb)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        creationflags=_BELOW_NORMAL_PRIORITY_CLASS,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"o filho falhou ({completed.returncode}): {completed.stderr[-2000:]}")
    measured: dict[str, Any] = json.loads(completed.stdout.strip().splitlines()[-1])
    return measured


def waiting_child() -> None:
    """O lado do filho do teste entre processos: baixa como a tarefa, avisa, espera o pai subir a
    prioridade dele por fora e informa o que ficou (como o agente faz com lançador e supervisor)."""
    import os  # noqa: PLC0415

    from uniover_agent.adapters import windows_scheduling  # noqa: PLC0415

    _lower_like_the_scheduled_task()
    # O pid vem do próprio filho: o `python.exe` de um venv no Windows é um lançador que abre o
    # interpretador de verdade como outro processo (`Popen.pid` seria o do lançador).
    print(json.dumps([os.getpid(), windows_scheduling.read_priorities()]), flush=True)
    sys.stdin.readline()
    print(json.dumps(windows_scheduling.read_priorities()), flush=True)


def cross_process() -> dict[str, Any]:
    """Sobe a prioridade de OUTRO processo pelo pid (`OpenProcess`), o caminho do lançador e do
    supervisor. Só toca no filho que ele mesmo abriu."""
    from uniover_agent.adapters import windows_scheduling  # noqa: PLC0415

    process = subprocess.Popen(  # noqa: S603 - o próprio Python e este arquivo
        [sys.executable, __file__, "--waiting-child"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        creationflags=_BELOW_NORMAL_PRIORITY_CLASS,
    )
    assert process.stdin is not None  # noqa: S101 - PIPE pedido acima
    assert process.stdout is not None  # noqa: S101
    try:
        pid, before = json.loads(process.stdout.readline())
        result = windows_scheduling.restore_normal_priority(pid)
        process.stdin.write("\n")
        process.stdin.flush()
        after = json.loads(process.stdout.readline())
    finally:
        process.kill()
        process.wait(timeout=10)
    return {
        "before": before,
        "after": after,
        "changes": list(result.changes) if result else [],
        "failures": list(result.failures) if result else [],
    }


def verdict(measured: dict[str, Any], minimum_mb: int) -> list[str]:
    """O que não se confirmou (vazio: tudo certo)."""
    problems: list[str] = []
    after = measured["after"]
    if after is None:
        return ["sem leitura das prioridades"]
    if measured.get("main_thread_after") != [5, 2]:
        problems.append(f"thread principal {measured.get('main_thread_after')}, esperado [5, 2]")
    cross = measured.get("cross_process")
    if cross is not None and (cross["after"] != [0x20, 5, 2] or cross["failures"]):
        problems.append(f"outro processo pelo pid ficou {cross['after']} ({cross['failures']})")
    cpu, memory, io = after
    if cpu != _NORMAL_PRIORITY_CLASS:
        problems.append(f"CPU {cpu:#x}, esperado normal (0x20)")
    if memory != 5:  # noqa: PLR2004 - MEMORY_PRIORITY_NORMAL
        problems.append(f"memória {memory}, esperado 5")
    if io != 2:  # noqa: PLR2004 - IoPriorityNormal
        problems.append(f"E/S {io}, esperado 2")
    if not measured["protected"] or measured["hard_minimum_mb"] != minimum_mb:
        problems.append(f"mínimo duro {measured['hard_minimum_mb']} MB, esperado {minimum_mb} MB")
    touched = measured["working_set_after_touch_mb"]
    if touched is None or touched < minimum_mb:
        problems.append(f"conjunto de trabalho {touched} MB abaixo do mínimo {minimum_mb} MB")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--min-mb", type=int, default=16)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--waiting-child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if sys.platform != "win32":
        print("só no Windows")
        return 2
    if args.child:
        print(json.dumps(child(args.min_mb)))
        return 0
    if args.waiting_child:
        waiting_child()
        return 0
    measured = run_child(args.min_mb)
    measured["cross_process"] = cross_process()
    print(json.dumps(measured, ensure_ascii=False, indent=2))
    problems = verdict(measured, args.min_mb)
    for problem in problems:
        print(f"FALHOU: {problem}")
    if not problems:
        print(
            "ok: CPU, memória e E/S no normal e o mínimo duro em vigor; um EmptyWorkingSet "
            f"ainda leva o conjunto a {measured['working_set_after_empty_mb']} MB "
            "(limite conhecido)"
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
