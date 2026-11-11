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

Nada aqui lança erro: quem chama só precisa saber se deu certo. Fora do Windows, `False`.
"""

import logging
import sys
from typing import Final

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
