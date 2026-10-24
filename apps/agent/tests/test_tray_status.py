"""A bandeja consome somente um estado pequeno, sem token nem comandos da TV."""

import json
from pathlib import Path

import pytest

from uniover_agent.adapters.tray_status import TrayStatus
from uniover_agent.core.domain import TvState


def test_tray_status_writes_connected_tv_state_atomically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    status = TrayStatus("Sala")
    status.connected()
    status.tv_state(TvState("on", None, None, "hot"))

    saved = json.loads((tmp_path / "UniOver" / "runtime" / "tray-status.json").read_text())
    assert saved == {"connected": True, "power": "on", "tv_name": "Sala"}
