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
import os
import sys
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.installation import installation_base
from uniover_agent.ports.tray import NotifyIconEntry

_log = logging.getLogger(__name__)

SETTINGS_KEY: Final = r"Control Panel\NotifyIconSettings"
MARKER_FILE: Final = "tray-promoted.json"


def _optional(reg: Any, key: Any, name: str, default: Any) -> Any:
    try:
        return reg.QueryValueEx(key, name)[0]
    except OSError:
        return default


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
                tip = _optional(reg, key, "InitialTooltip", "")
                uid = _optional(reg, key, "UID", None)
        except OSError:
            return None
        return NotifyIconEntry(name, str(path), str(tip), uid if isinstance(uid, int) else None)

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

    def _read(self) -> list[str] | None:
        """Os executáveis marcados; `[]` sem marca nenhuma; `None` se há um arquivo que não dá para
        entender (queda no meio da gravação, edição à mão): o chamador trata como "na dúvida"."""
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError:
            return None
        try:
            data = json.loads(text)
        except ValueError:
            return None
        done = data.get("executables") if isinstance(data, dict) else None
        if not isinstance(done, list) or not all(isinstance(item, str) for item in done):
            return None
        return done

    def done(self, executable: str) -> bool:
        marked = self._read()
        if marked is None:
            # Marca ilegível: o ícone pode ter sido promovido e escondido depois. Não promove.
            _log.warning("a marca de promoção do ícone está ilegível; não vou promovê-lo")
            return True
        return executable.lower() in (item.lower() for item in marked)

    def _write(self, executables: list[str]) -> bool:
        """Grava por arquivo temporário e troca: uma queda nunca deixa meia marca."""
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"executables": executables}), encoding="utf-8")
            os.replace(temporary, self._path)
        except OSError:
            temporary.unlink(missing_ok=True)
            _log.warning("não consegui gravar a marca de promoção do ícone")
            return False
        return True

    def mark(self, executable: str) -> bool:
        marked = self._read()
        if marked is None:
            return False
        return self._write([*marked, executable])

    def forget(self, executable: str) -> None:
        marked = self._read()
        if marked is None:
            return
        self._write([item for item in marked if item.lower() != executable.lower()])
