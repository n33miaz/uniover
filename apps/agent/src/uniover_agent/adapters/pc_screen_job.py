"""Escopo de vida do processo descartável de medição no Windows."""

import ctypes
from ctypes import wintypes

_PROCESS_RIGHTS = 0x0100 | 0x0001  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
_EXTENDED_LIMIT_INFORMATION = 9
_KILL_ON_JOB_CLOSE = 0x2000


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("user_time", ctypes.c_longlong),
        ("job_time", ctypes.c_longlong),
        ("flags", wintypes.DWORD),
        ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t),
        ("active_process_limit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priority_class", wintypes.DWORD),
        ("scheduling_class", wintypes.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", _BasicLimits),
        ("io", ctypes.c_ulonglong * 6),
        ("memory", ctypes.c_size_t * 4),
    ]


class ScreenJob:
    """O processo de tela termina quando o agente perde o handle, inclusive numa queda."""

    def __init__(self, pid: int) -> None:
        kernel = ctypes.windll.kernel32
        kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        )
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self._handle = kernel.CreateJobObjectW(None, None)
        if not self._handle:
            raise OSError("Não foi possível isolar o processo de medição.")
        limits = _ExtendedLimits()
        limits.basic.flags = _KILL_ON_JOB_CLOSE
        try:
            if not kernel.SetInformationJobObject(
                self._handle,
                _EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise OSError("Não foi possível configurar o encerramento da medição.")
            process = kernel.OpenProcess(_PROCESS_RIGHTS, False, pid)
            if not process:
                raise OSError("O processo da medição já encerrou.")
            try:
                if not kernel.AssignProcessToJobObject(self._handle, process):
                    raise OSError("Não foi possível vincular o processo de medição ao agente.")
            finally:
                kernel.CloseHandle(process)
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        if self._handle:
            ctypes.windll.kernel32.CloseHandle(self._handle)
            self._handle = None
