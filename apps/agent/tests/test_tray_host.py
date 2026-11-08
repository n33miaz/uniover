"""Contrato do host visual sem abrir outra bandeja durante a suite automatica."""

import json
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest

from uniover_agent.adapters import tray_host
from uniover_agent.adapters.self_update import DRILL_ENV
from uniover_agent.adapters.tray_assets import assets_dir
from uniover_agent.adapters.tray_controller import TrayController
from uniover_agent.core.tray_model import TrayView


def test_host_state_keeps_the_menu_model_and_attention(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    view = TrayView("error", True, "UniOver: sem conexão - atenção")
    tray_host._write_state(
        state, view, tmp_path, balloon={"title": "Falha", "message": "Veja o registro"}
    )

    data = json.loads(state.read_text(encoding="utf-8"))
    assert data["status"] == "Sem conexão · Atenção"
    assert data["code"] == "error"
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


@pytest.mark.parametrize("state", ["connected", "reconnecting", "error", "updating"])
def test_host_state_carries_an_ascii_code_the_script_compares_instead_of_the_text(
    tmp_path: Path, state: str
) -> None:
    state_file = tmp_path / "state.json"
    tray_host._write_state(state_file, TrayView(cast(Any, state), False, "UniOver"), tmp_path)

    assert json.loads(state_file.read_text(encoding="utf-8"))["code"] == state


def test_the_host_script_is_ascii_only_and_picks_the_dot_color_by_state_code() -> None:
    # O Windows PowerShell 5.1 le o arquivo na pagina de codigo ANSI: um literal acentuado (como o
    # "Sem conexão" do estado) viraria outro texto e o ramo nunca casaria.
    script = tray_host.host_script().read_bytes()
    assert all(byte < 0x80 for byte in script), "tray-host.ps1 deve ser ASCII puro"
    text = script.decode("ascii")
    for code in ("reconnecting", "error", "updating"):
        assert f"$script:stateCode -eq '{code}'" in text
    assert "StartsWith(" not in text
    assert "$script:stateCode = [string]$view.code" in text


def test_host_state_recovers_when_windows_briefly_locks_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = tmp_path / "state.json"
    replace = os.replace
    attempts = 0

    def busy_once(source: Path, target: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PermissionError("arquivo aberto pelo host")
        replace(source, target)

    monkeypatch.setattr(os, "replace", busy_once)
    tray_host._write_state(state, TrayView("connected", False, "UniOver: conectado"), tmp_path)
    assert attempts == 2
    assert json.loads(state.read_text(encoding="utf-8"))["status"] == "Conectado"


def test_host_state_that_stays_locked_warns_once_without_raising(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    state = tmp_path / "state.json"
    monkeypatch.setattr(os, "replace", _always_locked)
    monkeypatch.setattr("uniover_agent.adapters.tray_host.time.sleep", lambda _: None)
    monkeypatch.setattr(tray_host, "_last_warning", float("-inf"))
    view = TrayView("connected", False, "UniOver: conectado")
    recorded: list[tuple[str, str, str]] = []

    with caplog.at_level("WARNING", logger=tray_host.__name__):
        for _ in range(3):
            tray_host._write_state(
                state, view, tmp_path, record=lambda *event: recorded.append(event)
            )

    assert recorded == [("tray.state_write_failed", "warn", "PermissionError")]

    warnings = [record for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    assert warnings[0].exc_info is None
    assert list(tmp_path.glob("*.new")) == []

    monkeypatch.undo()
    tray_host._write_state(state, view, tmp_path)
    assert json.loads(state.read_text(encoding="utf-8"))["status"] == "Conectado"


def _always_locked(source: Path, target: Path) -> None:
    raise PermissionError("[WinError 5] arquivo aberto pelo host")


def test_missing_host_uses_pystray_without_starting_a_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tray_host, "host_script", lambda: tmp_path / "missing.ps1")
    called: list[str] = []
    result = tray_host.run_host(
        tmp_path,
        tmp_path,
        TrayView("connected", False, "UniOver: conectado"),
        cast(TrayController, None),  # não é consultado sem script
        lambda _: called.append("stop"),
        lambda _: called.append("notify"),
        lambda *_: called.append("record"),
    )
    assert result is False
    assert called == []


@pytest.mark.skipif(os.name != "nt", reason="host PowerShell do Windows")
def test_host_startup_failure_returns_to_pystray(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    incidents: list[str] = []
    result = tray_host.run_host(
        tmp_path,
        tmp_path,  # nao contem o .ico esperado
        TrayView("connected", False, "UniOver: conectado"),
        cast(TrayController, None),  # host falha antes de consultar controlador
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
def test_real_host_opens_and_exits_without_a_console(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    alarms: list[str] = []

    class Controller:
        def refresh(self) -> TrayView:
            return TrayView("connected", False, "UniOver: conectado")

        def handle(self, action: str) -> None:
            alarms.append(action)

    def set_stop(callback: Callable[[], None]) -> None:
        threading.Timer(2.0, callback).start()

    assert tray_host.run_host(
        tmp_path,
        assets_dir(),
        TrayView("connected", False, "UniOver: conectado"),
        cast(TrayController, Controller()),  # modelo mínimo de controlador
        set_stop,
        lambda _: None,
        lambda kind, *_: alarms.append(kind),
    )
    assert alarms == []
    assert not (tmp_path / "runtime" / "tray-host-state.json").exists()
