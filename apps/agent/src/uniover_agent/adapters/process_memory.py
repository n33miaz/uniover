"""Memória do próprio processo (só diagnóstico): falhas de página e conjunto de trabalho.

Uma parada curta dos dois laços ao mesmo tempo, com um processo vizinho sem parar, aponta para
dentro do agente. Falha de página (a página voltou do disco) é uma das causas: um minuto com muitas
delas, junto de um atraso, aponta para memória e não para o GIL. Fora do Windows não há leitura.
"""

import sys
from typing import NamedTuple


class MemoryCounters(NamedTuple):
    page_faults: int  # acumulado desde o início do processo
    working_set_bytes: int  # tamanho atual do conjunto de trabalho


def read_memory_counters() -> MemoryCounters | None:
    """`GetProcessMemoryInfo` do próprio processo; `None` fora do Windows ou se a chamada falhar."""
    if sys.platform != "win32":
        return None
    import ctypes  # noqa: PLC0415 - só no Windows
    from ctypes import wintypes  # noqa: PLC0415

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = (
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        )

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.K32GetProcessMemoryInfo.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    )
    kernel32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    if not kernel32.K32GetProcessMemoryInfo(
        kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb
    ):
        return None
    return MemoryCounters(int(counters.PageFaultCount), int(counters.WorkingSetSize))
