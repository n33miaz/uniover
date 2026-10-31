r"""O registro de ícones do Windows 11 (`NotifyIconSettings`) e a marca de "já promovido" em
`runtime`.

Não documentado pela Microsoft: a chave `HKCU\Control Panel\NotifyIconSettings\<id>` guarda, por
ícone de bandeja, `ExecutablePath` (quem o criou), `InitialTooltip`, `UID` e `IsPromoted` (1 na
barra, 0 no menu "^"). Mexer em `IsPromoted` é o que programas de terceiros fazem; o Windows pode
ignorar a mudança até o próximo registro do ícone. Só este módulo toca no registro, e os testes o
trocam por um falso: nenhum teste lê nem escreve o registro real.
"""

import json
import logging
import sys
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.ports.tray import NotifyIconEntry

_log = logging.getLogger(__name__)

SETTINGS_KEY: Final = r"Control Panel\NotifyIconSettings"
MARKER_FILE: Final = "tray-promoted.json"


class WindowsNotifyIconSettings:
    def entries(self) -> list[NotifyIconEntry]:
        if sys.platform != "win32":
            return []
        import winreg  # noqa: PLC0415 - só existe no Windows

        found: list[NotifyIconEntry] = []
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SETTINGS_KEY) as root:
                index = 0
                while True:
                    try:
                        name = winreg.EnumKey(root, index)
                    except OSError:
                        break
                    index += 1
                    entry = self._read(winreg, root, name)
                    if entry is not None:
                        found.append(entry)
        except OSError:
            return []
        return found

    @staticmethod
    def _read(reg: Any, root: Any, name: str) -> NotifyIconEntry | None:
        try:
            with reg.OpenKey(root, name) as key:
                path, _ = reg.QueryValueEx(key, "ExecutablePath")
                try:
                    tip, _ = reg.QueryValueEx(key, "InitialTooltip")
                except OSError:
                    tip = ""
        except OSError:
            return None
        return NotifyIconEntry(name, str(path), str(tip))

    def promote(self, key: str) -> bool:
        if sys.platform != "win32":
            return False
        import winreg  # noqa: PLC0415

        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, f"{SETTINGS_KEY}\\{key}", 0, winreg.KEY_SET_VALUE
            ) as handle:
                winreg.SetValueEx(handle, "IsPromoted", 0, winreg.REG_DWORD, 1)
        except OSError:
            _log.warning("não consegui promover o ícone da bandeja")
            return False
        return True


class FilePromotionMarker:
    r"""`runtime\tray-promoted.json`: os executáveis que já foram promovidos (nunca de novo, nem se
    a pessoa esconder)."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or installation_base() / "runtime" / MARKER_FILE

    def _read(self) -> list[str]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            return []
        done = data.get("executables") if isinstance(data, dict) else None
        return [item for item in done if isinstance(item, str)] if isinstance(done, list) else []

    def done(self, executable: str) -> bool:
        return executable.lower() in (item.lower() for item in self._read())

    def mark(self, executable: str) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"executables": [*self._read(), executable]}
            self._path.write_text(json.dumps(payload), encoding="utf-8")
        except OSError:
            _log.warning("não consegui gravar a marca de promoção do ícone")
