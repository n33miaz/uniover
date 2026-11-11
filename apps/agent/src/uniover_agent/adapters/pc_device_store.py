"""As decisões sobre aparelhos num arquivo JSON da instalação (gravação atômica)."""

import json
import logging
import os
from pathlib import Path
from typing import Final

from uniover_agent.ports.pc_devices import DeviceRecord

_log = logging.getLogger(__name__)

VERSION: Final = 1


class JsonDeviceStore:
    """`runtime\\pc-devices.json`: chave resumida do aparelho, decisão, nome e instante. Um arquivo
    ilegível vale como vazio (o dono é perguntado de novo): nunca derruba o agente."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._seen = self._read_seen()

    def _read_seen(self) -> bool:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            return False
        return isinstance(data, dict) and data.get("apiSeen") is True

    def api_seen(self) -> bool:
        return self._seen

    def mark_api_seen(self) -> None:
        """Grava que a API já listou a aprovação: o modo "API sem aprovação" não volta mais."""
        if self._seen:
            return
        # Só vale como visto DEPOIS de gravar: se a gravação falhar, tenta de novo na próxima vez.
        self._write(self.load(), seen=True)
        self._seen = True

    def load(self) -> dict[str, DeviceRecord]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except OSError, ValueError:
            _log.warning("arquivo dos aparelhos aprovados ilegível; recomeçando sem ele")
            return {}
        devices = data.get("devices") if isinstance(data, dict) else None
        records: dict[str, DeviceRecord] = {}
        for key, item in devices.items() if isinstance(devices, dict) else ():
            if (
                isinstance(key, str)
                and isinstance(item, dict)
                and item.get("state") in {"approved", "denied"}
                and isinstance(item.get("name"), str)
                and isinstance(item.get("at"), int | float)
            ):
                records[key] = DeviceRecord(item["state"], item["name"], float(item["at"]))
        return records

    def save(self, records: dict[str, DeviceRecord]) -> None:
        self._write(records)

    def _write(self, records: dict[str, DeviceRecord], *, seen: bool | None = None) -> None:
        body = {
            "version": VERSION,
            "apiSeen": self._seen if seen is None else seen,
            "devices": {
                key: {"state": r.state, "name": r.name, "at": r.at} for key, r in records.items()
            },
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temporary, self._path)
