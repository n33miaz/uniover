"""Estado da permissão do ADB na TV, contado ao app: `granted`, `missing` ou `pending`.

O adaptador do ADB é quem sabe (ver `AdbPermissionSink`); aqui o estado só é guardado, repassado a
quem ouve (o publicador do `tv.state.v1`, que avisa o celular) e anotado no diagnóstico, para o
administrador ver em Sistema **por que** o agente se recusou a conectar (IP novo, chave trocada,
a TV recusou a chave, nenhum toque provou a permissão).

Nada aqui fala com a TV nem abre aviso nenhum: só repassa o que o adaptador já viu.
"""

import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.ports import AdbPermissionState
from uniover_agent.ports.diagnostics import Severity

_log = logging.getLogger(__name__)

DIAGNOSTIC_KIND: Final = "adb.permission"
DIAGNOSTIC_COMPONENT: Final = "tv_adb"

Recorder = Callable[[str, Severity, str], None]


class AdbPermissionTracker:
    """Guarda o estado atual (`None` até o ADB dizer algo) e avisa quem ouve a cada mudança."""

    def __init__(self) -> None:
        self._state: AdbPermissionState | None = None
        self._reason = ""
        self._listeners: list[Callable[[], None]] = []
        self._recorder: Recorder | None = None

    @property
    def state(self) -> AdbPermissionState | None:
        return self._state

    @property
    def reason(self) -> str:
        return self._reason

    def on_change(self, listener: Callable[[], None]) -> None:
        """Chamado (síncrono, dentro do laço de eventos) quando o estado muda."""
        self._listeners.append(listener)

    def record_with(self, recorder: Recorder) -> None:
        """Liga o diagnóstico: cada mudança vira uma ocorrência `adb.permission.<estado>`."""
        self._recorder = recorder

    def report(self, state: AdbPermissionState, reason: str, detail: str = "") -> None:
        """Implementa `AdbPermissionSink`: estado ou motivo novos vão aos ouvintes."""
        changed = state != self._state
        if not changed and reason == self._reason:
            return
        self._state, self._reason = state, reason
        self._write(state, reason, detail)
        for listener in self._listeners:
            try:
                listener()
            except Exception:
                _log.exception("falha ao avisar a mudança da permissão do ADB")

    def _write(self, state: AdbPermissionState, reason: str, detail: str) -> None:
        text = f"{state}: {reason}" + (f" ({detail})" if detail else "")
        level = _log.warning if state == "missing" else _log.info
        level("permissão do ADB na TV: %s", text)
        if self._recorder is None:
            return
        severity: Severity = "warn" if state == "missing" else "info"
        try:
            self._recorder(f"{DIAGNOSTIC_KIND}.{state}", severity, text)
        except Exception:
            _log.exception("falha ao anotar a permissão do ADB no diagnóstico")
