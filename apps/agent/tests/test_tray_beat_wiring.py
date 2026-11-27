"""A bandeja liga a prova de vida da tela aos dois hosts de ícone, e o "Sair" a retira."""

import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

if sys.platform != "win32":
    # Importar a bandeja carrega o pystray, que num Linux sem tela falha já na importação.
    pytest.skip("precisa do Windows: o ícone da bandeja", allow_module_level=True)

from pystray._util import win32  # type: ignore[import-untyped]

from uniover_agent.adapters import tray
from uniover_agent.adapters.update_basics import DRILL_ENV
from uniover_agent.core.tray_model import TrayView


class _Beats:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls

    def beat(self) -> None:
        self.calls.append("beat")

    def suspend(self) -> None:
        self.calls.append("suspend")

    def withdraw(self) -> None:
        self.calls.append("withdraw")


class _Stop(BaseException):
    """Encerra o laço de atualização depois de uma volta."""


@pytest.fixture
def calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    seen: list[str] = []
    monkeypatch.setenv("UNIOVER_HOME", str(tmp_path))
    monkeypatch.setenv(DRILL_ENV, "1")
    monkeypatch.setattr(tray, "TrayBeat", lambda: _Beats(seen))
    return seen


def _recorder() -> Any:
    return lambda *_: None


def test_quitting_withdraws_the_tray_before_the_icon_closes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, calls: list[str]
) -> None:
    monkeypatch.delenv("UNIOVER_TRAY_NATIVE", raising=False)

    def host(
        _base: Path,
        _assets: Path,
        _first: object,
        controller: Any,
        set_stop: Callable[[Callable[[], None]], None],
        _set_notify: object,
        _record: object,
        indicator: _Beats,
    ) -> bool:
        set_stop(lambda: calls.append("closed"))
        indicator.beat()
        controller.handle("quit")
        return True

    monkeypatch.setattr(tray, "run_host", host)

    assert tray._run(tmp_path, _recorder()) == 0

    # O segundo `withdraw` é o da saída do processo.
    assert calls == ["beat", "withdraw", "closed", "withdraw"]


@pytest.mark.parametrize(
    "failure",
    [None, "add", "change", "refresh"],
    ids=["sucesso", "falha-ao-adicionar", "falha-ao-mudar", "falha-ao-renovar"],
)
def test_the_fallback_beats_and_acknowledges_only_after_the_shell_accepts_the_icon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, calls: list[str], failure: str | None
) -> None:
    monkeypatch.setenv("UNIOVER_TRAY_NATIVE", "0")
    session = "b" * 32
    monkeypatch.setattr(tray, "acknowledge_viewing", calls.append)
    threads: list[Callable[[], None]] = []
    failed = False
    attempts: list[tuple[int, int]] = []

    def notify(code: int, data: Any) -> bool:
        nonlocal failed
        command = code, data.uFlags
        attempts.append(command)
        rejected = {
            "add": (win32.NIM_ADD, win32.NIF_MESSAGE | win32.NIF_ICON | win32.NIF_TIP),
            "change": (win32.NIM_MODIFY, win32.NIF_ICON),
            "refresh": (win32.NIM_MODIFY, win32.NIF_ICON | win32.NIF_TIP),
        }
        if failure and not failed and command == rejected[failure]:
            failed = True
            return False
        return True

    def run(icon: tray.SharpIcon, setup: Callable[[Any], None]) -> None:
        setup(icon)
        # Roda em primeiro plano, sem janela do pystray nem ícone no Shell.
        with pytest.raises(_Stop):
            threads[0]()

    def thread(target: Callable[[], None], daemon: bool) -> SimpleNamespace:
        threads.append(target)
        return SimpleNamespace(start=lambda: None)

    monkeypatch.setattr(win32, "Shell_NotifyIcon", notify)
    monkeypatch.setattr(tray.SharpIcon, "run", run)
    monkeypatch.setattr(tray, "threading", SimpleNamespace(Thread=thread))
    monkeypatch.setattr(tray, "create_tray_wake_event", lambda: None)
    waits = 0

    def sleep(_seconds: float) -> None:
        nonlocal waits
        waits += 1
        if failure and waits == 1:
            assert failed
            assert calls == ["suspend"]
            return
        raise _Stop

    monkeypatch.setattr(tray, "time", SimpleNamespace(sleep=sleep))

    class Controller:
        def refresh(self, announce: bool = True) -> TrayView:
            if failure == "change" and not announce:
                return TrayView("connected", False, "UniOver")
            return TrayView("viewing", False, "UniOver", screen_session=session)

    monkeypatch.setattr(tray, "TrayController", lambda _env: Controller())

    assert tray._run(tmp_path, _recorder()) == 0
    assert calls == (["suspend"] if failure else []) + ["beat", session, "withdraw"]
    assert [code for code, _ in attempts].count(win32.NIM_ADD) == (2 if failure else 1)
