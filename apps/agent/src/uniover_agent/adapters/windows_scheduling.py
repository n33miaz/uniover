"""Prioridade e memória do agente no Windows: a entrada do PC não pode ficar sem vez nem sem página.

Sob pouca memória o Windows corta o conjunto de trabalho do processo (as páginas voltam do disco,
uma falha de página por vez) e o laço para por dezenas de segundos. Duas defesas, sem exigir
administrador:

- a thread da entrada do PC roda com prioridade acima do normal (`SetThreadPriority`): perde a
  disputa por CPU para menos coisas;
- o processo pede um conjunto de trabalho mínimo "duro" (`SetProcessWorkingSetSizeEx` com
  `QUOTA_LIMITS_HARDWS_MIN_ENABLE`): o Windows não corta as páginas residentes abaixo dele. Um
  usuário comum já tem o privilégio para isso (medido: os pedidos de 32 MB e de 64 MB foram aceitos
  sem ativar nada). Se o Windows recusar (política, memória), o agente segue sem a proteção e
  registra.

Medido em 12/11 no PC do dono: o mínimo duro sozinho NÃO segura o agente. Com 64 MB pedidos e
aceitos (bandeiras 0x9), o conjunto de trabalho estava em 38 MB; um limpador de memória
(`EmptyWorkingSet`, como o Mem Reduct) esvazia o processo inteiro mesmo com o mínimo duro (provado
num processo de teste: 54 MB -> 0 MB). E a tarefa agendada (prioridade 7, o padrão do Agendador)
põe o lançador, o supervisor e o agente em CPU abaixo do normal, memória 2 (baixa) e E/S 1 (baixa):
as páginas do agente são as primeiras a serem reaproveitadas, e cada página que volta do disco é
lida na fila de E/S de menor prioridade, atrás de todo o resto: a causa provável das paradas de
minutos (as prioridades foram medidas; a melhora sob carga ainda não, sem carga provocada). Por isso
`restore_normal_priority` devolve ao normal (nunca acima) CPU, memória e E/S, e desliga o EcoQoS.

Nada aqui lança erro: quem chama só precisa saber se deu certo. Fora do Windows, `False`.
"""

import logging
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

_log = logging.getLogger(__name__)

# `THREAD_PRIORITY_ABOVE_NORMAL` (uma faixa acima do normal; nada de tempo real).
THREAD_PRIORITY_ABOVE_NORMAL: Final = 1
# `QUOTA_LIMITS_HARDWS_MIN_ENABLE` e `QUOTA_LIMITS_HARDWS_MAX_DISABLE`: o mínimo é duro, sem teto.
_HARD_MIN_ENABLE: Final = 0x1
_HARD_MAX_DISABLE: Final = 0x8
_MEGABYTE: Final = 1024 * 1024
# Teto do pedido: acima disto o "mínimo" vira reserva de memória, e não é esse o propósito.
MAX_WORKING_SET_MIN_MB: Final = 512


def raise_thread_priority() -> bool:
    """Põe a thread que chama acima do normal. `False` se o Windows recusou ou não há Windows."""
    if sys.platform != "win32":
        return False
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentThread.restype = wintypes.HANDLE
    kernel32.SetThreadPriority.argtypes = (wintypes.HANDLE, ctypes.c_int)
    kernel32.SetThreadPriority.restype = wintypes.BOOL
    if kernel32.SetThreadPriority(kernel32.GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL):
        return True
    _log.warning(
        "o Windows recusou a prioridade da thread de entrada do PC (erro %d); sigo sem ela",
        ctypes.get_last_error(),
    )
    return False


def protect_working_set(minimum_mb: int) -> bool:
    """Pede ao Windows que não corte o conjunto de trabalho deste processo abaixo de `minimum_mb`.

    `0` (ou negativo) desliga o pedido. `False` se o Windows recusou, e então o agente segue sem a
    proteção.
    """
    if sys.platform != "win32" or minimum_mb <= 0:
        return False
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetProcessWorkingSetSizeEx.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.GetProcessWorkingSetSizeEx.restype = wintypes.BOOL
    kernel32.SetProcessWorkingSetSizeEx.argtypes = (
        wintypes.HANDLE,
        ctypes.c_size_t,
        ctypes.c_size_t,
        wintypes.DWORD,
    )
    kernel32.SetProcessWorkingSetSizeEx.restype = wintypes.BOOL
    process = kernel32.GetCurrentProcess()
    minimum = ctypes.c_size_t()
    maximum = ctypes.c_size_t()
    flags = wintypes.DWORD()
    if not kernel32.GetProcessWorkingSetSizeEx(
        process, ctypes.byref(minimum), ctypes.byref(maximum), ctypes.byref(flags)
    ):
        _log.warning("não consegui ler o conjunto de trabalho (erro %d)", ctypes.get_last_error())
        return False
    wanted = min(minimum_mb, MAX_WORKING_SET_MIN_MB) * _MEGABYTE
    # O máximo nunca fica abaixo do mínimo pedido; o que já era maior continua.
    ceiling = max(maximum.value, wanted * 2)
    if kernel32.SetProcessWorkingSetSizeEx(
        process, wanted, ceiling, _HARD_MIN_ENABLE | _HARD_MAX_DISABLE
    ):
        return True
    _log.warning(
        "o Windows recusou proteger o conjunto de trabalho do agente (erro %d); sigo sem a "
        "proteção",
        ctypes.get_last_error(),
    )
    return False


def read_hard_minimum() -> int | None:
    """O mínimo duro em vigor (bytes; 0 se o mínimo não é duro); `None` sem leitura."""
    if sys.platform != "win32":
        return None
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetProcessWorkingSetSizeEx.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.GetProcessWorkingSetSizeEx.restype = wintypes.BOOL
    minimum = ctypes.c_size_t()
    maximum = ctypes.c_size_t()
    flags = wintypes.DWORD()
    if not kernel32.GetProcessWorkingSetSizeEx(
        kernel32.GetCurrentProcess(),
        ctypes.byref(minimum),
        ctypes.byref(maximum),
        ctypes.byref(flags),
    ):
        return None
    return int(minimum.value) if flags.value & _HARD_MIN_ENABLE else 0


# ---- prioridade do processo (CPU, memória, E/S e EcoQoS) --------------------------------------

_NORMAL_PRIORITY_CLASS: Final = 0x20
# `IDLE_PRIORITY_CLASS` e `BELOW_NORMAL_PRIORITY_CLASS`: as únicas que sobem; acima do normal fica.
_LOWER_PRIORITY_CLASSES: Final = {0x40: "ociosa", 0x4000: "abaixo do normal"}
MEMORY_PRIORITY_NORMAL: Final = 5
IO_PRIORITY_NORMAL: Final = 2
_PROCESS_MEMORY_PRIORITY: Final = 0  # `ProcessMemoryPriority`
_PROCESS_POWER_THROTTLING: Final = 4  # `ProcessPowerThrottling`
_NT_PROCESS_IO_PRIORITY: Final = 33  # `ProcessIoPriority` (ntdll)
_POWER_THROTTLING_EXECUTION_SPEED: Final = 0x1
_PROCESS_SET_INFORMATION: Final = 0x0200
_PROCESS_QUERY_INFORMATION: Final = 0x0400
_TH32CS_SNAPPROCESS: Final = 0x2
# Quem vigia o agente: o lançador e o supervisor são scripts do Windows PowerShell.
SUPERVISOR_IMAGES: Final = frozenset({"powershell.exe", "pwsh.exe"})
_MAX_ANCESTORS: Final = 8
# O lançador e o supervisor declaram no ambiente do filho "<pid>:<hora de criação em FILETIME>". Só
# um ancestral declarado, com a MESMA hora de criação, é tocado: um PowerShell interativo da pessoa
# nunca se declara, e um pid reaproveitado por outro processo tem outra hora de criação.
WATCHER_VARIABLES: Final = ("UNIOVER_LAUNCHER_PROCESS", "UNIOVER_SUPERVISOR_PROCESS")
_DECLARED: Final = re.compile(r"^(\d+):(\d+)$")


@dataclass(frozen=True)
class PriorityResult:
    """O que mudou (em texto, para o registro) e o que o Windows recusou."""

    changes: tuple[str, ...]
    failures: tuple[str, ...]

    def describe(self) -> str:
        return ", ".join(self.changes) if self.changes else "já estava no normal"


@dataclass(frozen=True)
class _Refused:
    """O Windows recusou ler ou mudar uma prioridade; `detail` traz o erro (ou o NTSTATUS)."""

    detail: str


def _status(value: int) -> str:
    return f"status 0x{value & 0xFFFFFFFF:08x}"


def _api() -> tuple[Any, Any, Any, Any]:
    """ctypes, wintypes, kernel32 e ntdll com as assinaturas usadas aqui (só no Windows)."""
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.GetPriorityClass.argtypes = (wintypes.HANDLE,)
    kernel32.GetPriorityClass.restype = wintypes.DWORD
    kernel32.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.SetPriorityClass.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.c_void_p,) * 4
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    for name in ("GetProcessInformation", "SetProcessInformation"):
        function = getattr(kernel32, name)
        function.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        function.restype = wintypes.BOOL
    ntdll.NtQueryInformationProcess.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.ULONG,
        ctypes.c_void_p,
    )
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    ntdll.NtSetInformationProcess.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.ULONG,
    )
    ntdll.NtSetInformationProcess.restype = ctypes.c_long
    return ctypes, wintypes, kernel32, ntdll


def _raise_cpu_priority(api: tuple[Any, Any, Any, Any], handle: Any) -> str | _Refused:
    """CPU: de ociosa ou abaixo do normal para normal (acima do normal fica como está).

    O que mudou (texto), `""` se já estava no normal, `_Refused` se o Windows recusou ler ou mudar:
    uma leitura que falha não é "já estava no normal"."""
    ctypes, _, kernel32, _ = api
    current = int(kernel32.GetPriorityClass(handle))
    if current == 0:
        return _Refused(f"leitura, erro {ctypes.get_last_error()}")
    if current not in _LOWER_PRIORITY_CLASSES:
        return ""
    if kernel32.SetPriorityClass(handle, _NORMAL_PRIORITY_CLASS):
        return f"CPU {_LOWER_PRIORITY_CLASSES[current]} -> normal"
    return _Refused(f"erro {ctypes.get_last_error()}")


def _raise_memory_priority(api: tuple[Any, Any, Any, Any], handle: Any) -> str | _Refused:
    """Memória: como `_raise_cpu_priority`."""
    ctypes, wintypes, kernel32, _ = api
    memory = wintypes.ULONG(MEMORY_PRIORITY_NORMAL)
    size = ctypes.sizeof(memory)
    if not kernel32.GetProcessInformation(
        handle, _PROCESS_MEMORY_PRIORITY, ctypes.byref(memory), size
    ):
        return _Refused(f"leitura, erro {ctypes.get_last_error()}")
    before = int(memory.value)
    if before >= MEMORY_PRIORITY_NORMAL:
        return ""
    memory.value = MEMORY_PRIORITY_NORMAL
    if kernel32.SetProcessInformation(handle, _PROCESS_MEMORY_PRIORITY, ctypes.byref(memory), size):
        return f"memória {before} -> {MEMORY_PRIORITY_NORMAL}"
    return _Refused(f"erro {ctypes.get_last_error()}")


def _raise_io_priority(api: tuple[Any, Any, Any, Any], handle: Any) -> str | _Refused:
    """E/S (a fila em que as páginas voltam do disco): como `_raise_cpu_priority`."""
    ctypes, wintypes, _, ntdll = api
    io = wintypes.ULONG(IO_PRIORITY_NORMAL)
    size = ctypes.sizeof(io)
    status = int(
        ntdll.NtQueryInformationProcess(
            handle, _NT_PROCESS_IO_PRIORITY, ctypes.byref(io), size, None
        )
    )
    if status:
        return _Refused(f"leitura, {_status(status)}")
    before = int(io.value)
    if before >= IO_PRIORITY_NORMAL:
        return ""
    io.value = IO_PRIORITY_NORMAL
    status = int(
        ntdll.NtSetInformationProcess(handle, _NT_PROCESS_IO_PRIORITY, ctypes.byref(io), size)
    )
    if status:
        return _Refused(_status(status))
    return f"E/S {before} -> {IO_PRIORITY_NORMAL}"


def _creation_time(api: tuple[Any, Any, Any, Any], handle: Any) -> int | None:
    """A hora de criação do processo (FILETIME, UTC); `None` sem leitura."""
    ctypes, _, kernel32, _ = api
    created, exited, kernel, user = (ctypes.c_ulonglong() for _ in range(4))
    if not kernel32.GetProcessTimes(
        handle,
        ctypes.byref(created),
        ctypes.byref(exited),
        ctypes.byref(kernel),
        ctypes.byref(user),
    ):
        return None
    return int(created.value)


def _turn_off_eco_qos(api: tuple[Any, Any, Any, Any], handle: Any) -> bool:
    ctypes, wintypes, kernel32, _ = api

    class PowerThrottlingState(ctypes.Structure):  # type: ignore[misc,name-defined]
        _fields_ = (
            ("Version", wintypes.ULONG),
            ("ControlMask", wintypes.ULONG),
            ("StateMask", wintypes.ULONG),
        )

    # Controlar a velocidade e deixá-la desligada: o Windows não põe o processo em EcoQoS.
    state = PowerThrottlingState(1, _POWER_THROTTLING_EXECUTION_SPEED, 0)
    return bool(
        kernel32.SetProcessInformation(
            handle, _PROCESS_POWER_THROTTLING, ctypes.byref(state), ctypes.sizeof(state)
        )
    )


def restore_normal_priority(
    pid: int | None = None, created: int | None = None
) -> PriorityResult | None:
    """Devolve ao normal a CPU, a memória e a E/S do processo (`None`: este) e desliga o EcoQoS.

    Só sobe o que está abaixo do normal; nunca põe nada acima. Com `created` (FILETIME), o processo
    aberto só é tocado se nasceu exatamente nessa hora: a conferência é feita no próprio handle, sem
    corrida com um pid reaproveitado. `None` fora do Windows ou quando o processo não confere.
    """
    if sys.platform != "win32":
        return None
    api = _api()
    ctypes, _, kernel32, _ = api
    if pid is None:
        handle = kernel32.GetCurrentProcess()
    else:
        handle = kernel32.OpenProcess(
            _PROCESS_SET_INFORMATION | _PROCESS_QUERY_INFORMATION, False, pid
        )
        if not handle:
            return PriorityResult((), (f"abrir o processo (erro {ctypes.get_last_error()})",))
    try:
        if created is not None:
            actual = _creation_time(api, handle)
            if actual != created:
                _log.debug(
                    "o pid %s não é o processo declarado (nasceu em %s, esperado %s); não toco",
                    pid,
                    actual,
                    created,
                )
                return None
        return _raise_all(api, handle)
    finally:
        if pid is not None:
            kernel32.CloseHandle(handle)


def _raise_all(api: tuple[Any, Any, Any, Any], handle: Any) -> PriorityResult:
    ctypes = api[0]
    changes: list[str] = []
    failures: list[str] = []
    steps = (
        ("CPU", _raise_cpu_priority),
        ("memória", _raise_memory_priority),
        ("E/S", _raise_io_priority),
    )
    for what, step in steps:
        changed = step(api, handle)
        if isinstance(changed, _Refused):
            failures.append(f"{what} ({changed.detail})")
        elif changed:
            changes.append(changed)
    if _turn_off_eco_qos(api, handle):
        changes.append("EcoQoS desligado")
    else:
        failures.append(f"EcoQoS (erro {ctypes.get_last_error()})")
    return PriorityResult(tuple(changes), tuple(failures))


def read_priorities() -> tuple[int, int, int] | None:
    """(classe de CPU, prioridade de memória, prioridade de E/S) deste processo; `None` sem
    Windows ou sem leitura. Para a bancada e os testes."""
    if sys.platform != "win32":
        return None
    ctypes, wintypes, kernel32, ntdll = _api()
    handle = kernel32.GetCurrentProcess()
    memory = wintypes.ULONG()
    io = wintypes.ULONG()
    if not kernel32.GetProcessInformation(
        handle, _PROCESS_MEMORY_PRIORITY, ctypes.byref(memory), ctypes.sizeof(memory)
    ) or ntdll.NtQueryInformationProcess(
        handle, _NT_PROCESS_IO_PRIORITY, ctypes.byref(io), ctypes.sizeof(io), None
    ):
        return None
    return int(kernel32.GetPriorityClass(handle)), int(memory.value), int(io.value)


def walk_ancestors(
    table: dict[int, tuple[int, str]], start: int, images: frozenset[str] = SUPERVISOR_IMAGES
) -> list[int]:
    """Os ancestrais de `start` cuja imagem está em `images`, do mais próximo ao mais distante.

    `table` é pid -> (pid do pai, nome da imagem). Para num pai que já não existe, num ciclo (pid
    reaproveitado) ou depois de `_MAX_ANCESTORS` passos. O nome não basta para tocar no processo:
    `keep_agent_responsive` ainda exige a declaração e a hora de criação.
    """
    found: list[int] = []
    seen = {start}
    current = start
    for _ in range(_MAX_ANCESTORS):
        entry = table.get(current)
        if entry is None:
            break
        parent = entry[0]
        if parent in seen or parent not in table:
            break
        seen.add(parent)
        if table[parent][1].lower() in images:
            found.append(parent)
        current = parent
    return found


def process_table() -> dict[int, tuple[int, str]]:
    """pid -> (pid do pai, imagem) de todos os processos (`CreateToolhelp32Snapshot`); vazio se
    falhar ou fora do Windows."""
    if sys.platform != "win32":
        return {}
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    class ProcessEntry(ctypes.Structure):
        _fields_ = (
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        )

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.Process32FirstW.argtypes = (ctypes.c_void_p, ctypes.POINTER(ProcessEntry))
    kernel32.Process32NextW.argtypes = (ctypes.c_void_p, ctypes.POINTER(ProcessEntry))
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    snapshot = kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    # `INVALID_HANDLE_VALUE` é -1: como ponteiro sem sinal, o maior valor possível.
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        return {}
    table: dict[int, tuple[int, str]] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            table[int(entry.th32ProcessID)] = (int(entry.th32ParentProcessID), entry.szExeFile)
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return table


def declared_watchers(environ: Mapping[str, str]) -> dict[int, int]:
    """pid -> hora de criação (FILETIME) que o lançador e o supervisor declararam no ambiente."""
    declared: dict[int, int] = {}
    for name in WATCHER_VARIABLES:
        match = _DECLARED.match(environ.get(name, "").strip())
        if match is not None:
            declared[int(match.group(1))] = int(match.group(2))
    return declared


def _log_result(who: str, result: PriorityResult) -> None:
    _log.info("prioridade %s: %s", who, result.describe())
    if result.failures:
        _log.warning(
            "o Windows recusou parte da prioridade %s (%s); sigo assim",
            who,
            ", ".join(result.failures),
        )


def keep_agent_responsive() -> None:
    """Na partida do agente: devolve ao normal a prioridade dele e a de quem o vigia.

    O lançador e o supervisor herdam da tarefa agendada a mesma prioridade baixa; travados pela
    paginação, o lançador confundia a parada com uma suspensão do PC. Só são tocados os ancestrais
    PowerShell que se declararam (`WATCHER_VARIABLES`) e que nasceram na hora declarada; o resto
    (um PowerShell interativo, um pid reaproveitado) fica como está, com uma linha em DEBUG. Cada
    recusa vira uma linha e o agente segue (nada aqui impede a partida). Os processos que o
    supervisor abrir depois (o próximo agente) já nascem dele com a CPU normal.
    """
    if sys.platform != "win32":
        return
    import os  # noqa: PLC0415

    own = restore_normal_priority()
    if own is not None:
        _log_result("do agente", own)
    declared = declared_watchers(os.environ)
    for pid in walk_ancestors(process_table(), os.getpid()):
        created = declared.get(pid)
        if created is None:
            _log.debug(
                "o PowerShell ancestral %d não se declarou lançador/supervisor; não toco", pid
            )
            continue
        result = restore_normal_priority(pid, created)
        if result is not None:
            _log_result(f"do lançador/supervisor (pid {pid})", result)
