"""Contrato do host visual sem abrir outra bandeja durante a suite automatica."""

import json
import os
import threading
from pathlib import Path

import pytest

from uniover_agent.adapters import tray_host
from uniover_agent.adapters.self_update import DRILL_ENV
from uniover_agent.adapters.tray_assets import assets_dir
from uniover_agent.core.tray_model import TrayView


def test_host_state_keeps_the_menu_model_and_attention(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    view = TrayView("error", True, "UniOver: sem conexão - atenção")
    tray_host._write_state(
        state, view, tmp_path, balloon={"title": "Falha", "message": "Veja o registro"}
    )

    data = json.loads(state.read_text(encoding="utf-8"))
    assert data["status"] == "Sem conexão · Atenção"
    assert data["icon"].endswith("error-attention.ico")
    assert [item["action"] for item in data["menu"] if item] == [
        "open",
        "status",
        "log",
        "update",
        "restart",
        "quit",
    ]
    assert data["balloon"]["message"] == "Veja o registro"


def test_host_state_recovers_when_windows_briefly_locks_the_file(
    tmp_path: Path, monkeypatch
) -> None:
    state = tmp_path / "state.json"
    replace = tray_host.os.replace
    attempts = 0

    def busy_once(source: Path, target: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PermissionError("arquivo aberto pelo host")
        replace(source, target)

    monkeypatch.setattr(tray_host.os, "replace", busy_once)
    tray_host._write_state(state, TrayView("connected", False, "UniOver: conectado"), tmp_path)
    assert attempts == 2
    assert json.loads(state.read_text(encoding="utf-8"))["status"] == "Conectado"


def test_missing_host_uses_pystray_without_starting_a_process(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(tray_host, "host_script", lambda: tmp_path / "missing.ps1")
    called: list[str] = []
    result = tray_host.run_host(
        tmp_path,
        tmp_path,
        TrayView("connected", False, "UniOver: conectado"),
        None,  # type: ignore[arg-type] - nao e consultado sem script
        lambda _: called.append("stop"),
        lambda _: called.append("notify"),
        lambda *_: called.append("record"),
    )
    assert result is False
    assert called == []


@pytest.mark.skipif(os.name != "nt", reason="host PowerShell do Windows")
def test_host_startup_failure_returns_to_pystray(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    incidents: list[str] = []
    result = tray_host.run_host(
        tmp_path,
        tmp_path,  # nao contem o .ico esperado
        TrayView("connected", False, "UniOver: conectado"),
        None,  # type: ignore[arg-type] - host falha antes de consultar controlador
        lambda _: None,
        lambda _: None,
        lambda kind, *_: incidents.append(kind),
    )
    assert result is False
    assert incidents == ["tray.host_failed"]
    assert not (tmp_path / "runtime" / "tray-host-state.json").exists()


@pytest.mark.skipif(
    os.name != "nt" or os.environ.get("UNIOVER_TRAY_HOST_SMOKE") != "1",
    reason="ensaio visual opt-in no Windows interativo",
)
def test_real_host_opens_and_exits_without_a_console(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    alarms: list[str] = []

    class Controller:
        def refresh(self) -> TrayView:
            return TrayView("connected", False, "UniOver: conectado")

        def handle(self, action: str) -> None:
            alarms.append(action)

    def set_stop(callback) -> None:
        threading.Timer(2.0, callback).start()

    assert tray_host.run_host(
        tmp_path,
        assets_dir(),
        TrayView("connected", False, "UniOver: conectado"),
        Controller(),  # type: ignore[arg-type] - modelo minimo de controlador
        set_stop,
        lambda _: None,
        lambda kind, *_: alarms.append(kind),
    )
    assert alarms == []
    assert not (tmp_path / "runtime" / "tray-host-state.json").exists()
