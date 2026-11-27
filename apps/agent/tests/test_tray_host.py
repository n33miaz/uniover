"""Contrato do host visual sem abrir outra bandeja durante a suite automatica."""

import io
import json
import os
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from uniover_agent.adapters import pc_screen_presence, tray_host
from uniover_agent.adapters.pc_screen_presence import (
    TrayBeat,
    TrayUnavailableError,
    screen_indicator,
    tray_alive,
    viewing_session,
)
from uniover_agent.adapters.tray_assets import assets_dir
from uniover_agent.adapters.tray_controller import TrayController
from uniover_agent.adapters.update_basics import DRILL_ENV
from uniover_agent.core.tray_model import TrayView

from .test_tray_comes_back import POWERSHELL

windows_only = pytest.mark.skipif(os.name != "nt", reason="objetos nomeados do Windows")


@pytest.fixture(autouse=True)
def host_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    if os.name != "nt":
        monkeypatch.setattr(pc_screen_presence, "tray_tick", lambda _kernel=None: 1)


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
    # Ninguém vendo a tela: o host esconde o item de parar.
    assert data["viewing"] is None
    assert [item["action"] for item in data["menu"] if item] == [
        "stop_screen",
        "open",
        "status",
        "log",
        "update",
        "restart",
        "quit",
    ]
    assert data["balloon"]["message"] == "Veja o registro"


def test_host_state_names_the_drop_reason_and_the_advice_in_short_lines(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    tray_host._write_state(
        state, TrayView("error", False, "UniOver: sem internet em casa", "no_internet"), tmp_path
    )

    data = json.loads(state.read_text(encoding="utf-8"))
    assert data["status"] == "Sem internet em casa"
    # A cor do ponto e o ícone seguem o estado de sempre.
    assert data["code"] == "error"
    assert data["icon"].endswith("error.ico")
    assert len(data["hint"]) > 1
    assert all(len(line) <= 46 for line in data["hint"])
    assert "cabo USB" in " ".join(data["hint"])


def test_host_state_without_a_reason_has_no_advice(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    tray_host._write_state(state, TrayView("reconnecting", False, "UniOver"), tmp_path)

    data = json.loads(state.read_text(encoding="utf-8"))
    assert (data["status"], data["hint"]) == ("Reconectando", [])


def test_the_host_script_shows_the_advice_only_when_there_is_one() -> None:
    text = tray_host.host_script().read_text(encoding="ascii")

    assert "$hintLabel.Available = $false" in text
    assert "$hintLabel.Available = ($hintLines.Count -gt 0)" in text


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
    for code in ("reconnecting", "error", "updating", "viewing"):
        assert f"$script:stateCode -eq '{code}'" in text
    assert "StartsWith(" not in text
    assert "$script:stateCode = [string]$view.code" in text


def test_host_state_tells_the_script_which_viewing_the_stop_item_ends(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    view = TrayView("viewing", False, "UniOver", screen_session="a" * 32)
    tray_host._write_state(state, view, tmp_path)

    data = json.loads(state.read_text(encoding="utf-8"))
    assert (data["code"], data["status"]) == ("viewing", "Tela sendo vista")
    assert data["viewing"] == "a" * 32
    assert data["icon"].endswith("viewing.ico")
    assert data["menu"][0] == {"action": "stop_screen", "label": "Parar de mostrar a tela"}


def test_the_host_script_binds_the_stop_to_the_viewing_the_menu_showed() -> None:
    script = tray_host.host_script().read_text(encoding="ascii")

    # Escondido até haver alguém vendo; o identificador é o de quando o menu abriu.
    assert "$item.Available = $false" in script
    assert "$script:stopItem.Available = [bool]$script:viewing" in script
    assert "$menu.add_Opening({ $script:menuViewing = $script:viewing })" in script
    assert "$command += ' ' + $script:menuViewing" in script


class _FakeHost:
    """Um host que diz o que mandaram e depois fecha a saída, sem processo nem ícone."""

    def __init__(self, *lines: str) -> None:
        self.stdout = io.StringIO("".join(f"{line}\n" for line in lines))

    def poll(self) -> None:
        return None

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass

    def wait(self, timeout: float | None = None) -> int:
        return 0


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("ACTION stop_screen " + "a" * 32, [("stop_screen", "a" * 32)]),
        ("ACTION stop_screen ", [("stop_screen", None)]),
        ("ACTION status", [("status", None)]),
        ("ACTION apagar " + "a" * 32, []),
    ],
)
def test_host_commands_reach_the_controller_with_the_viewing_they_name(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    line: str,
    expected: list[tuple[str, str | None]],
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    monkeypatch.setattr(tray_host, "popen_hidden", lambda *_, **__: _FakeHost("READY", line))
    handled: list[tuple[str, str | None]] = []
    view = TrayView("connected", False, "UniOver")

    class Controller:
        def refresh(self) -> TrayView:
            return view

        def handle(self, action: str, screen_session: str | None = None) -> None:
            handled.append((action, screen_session))

    # A saída falsa acaba depois da linha: o host a trata como queda e devolve o controle.
    assert not tray_host.run_host(
        tmp_path,
        tmp_path,
        view,
        cast(TrayController, Controller()),
        lambda _: None,
        lambda _: None,
        lambda *_: None,
    )
    assert handled == expected


class _Lines:
    """A saída de um host que fala aos poucos; fechada, acaba na próxima volta."""

    def __init__(self, lines: Iterator[str], closed: threading.Event | None = None) -> None:
        self._lines = lines
        self._closed = closed

    def __iter__(self) -> Iterator[str]:
        return self._lines

    def close(self) -> None:
        if self._closed is not None:
            self._closed.set()


class _TalkingHost(_FakeHost):
    def __init__(self, lines: Iterator[str], closed: threading.Event | None = None) -> None:
        self.stdout = cast(io.StringIO, _Lines(lines, closed))


class _Beats:
    """A prova de vida falsa: anota o que o host pediu, na ordem."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.ticks: list[int] = []

    def beat(self, received_tick: int) -> None:
        self.calls.append("beat")
        self.ticks.append(received_tick)

    def suspend(self) -> None:
        self.calls.append("suspend")


_VIEW_ID = "a" * 32
_OLD_ID = "b" * 32


@pytest.mark.parametrize(
    ("session", "written", "lines", "beats", "acks"),
    [
        # `READY` e a gravação do estado, sozinhos, não provam que o ícone mudou.
        (None, True, ["ACTION status"], 0, []),
        (_VIEW_ID, True, ["ACTION status"], 0, []),
        (None, True, ["APPLIED "], 1, []),
        (_VIEW_ID, True, [f"APPLIED {_VIEW_ID}"], 1, [_VIEW_ID]),
        # Confirmação de outra visualização, ou de antes de ela começar, não vale.
        (_VIEW_ID, True, [f"APPLIED {_OLD_ID}", "APPLIED "], 0, []),
        (None, True, [f"APPLIED {_OLD_ID}"], 0, []),
        # Estado que não chegou ao host: nenhuma confirmação vale.
        (None, False, ["APPLIED "], 0, []),
        (_VIEW_ID, False, [f"APPLIED {_VIEW_ID}"], 0, []),
    ],
    ids=[
        "ocioso-sem-confirmacao",
        "vendo-sem-confirmacao",
        "ocioso-confirmado",
        "vendo-confirmado",
        "identificador-antigo",
        "visualizacao-encerrada",
        "ocioso-estado-preso",
        "vendo-estado-preso",
    ],
)
def test_the_tray_counts_as_alive_only_after_the_host_confirms_the_state(  # noqa: PLR0913, PLR0917
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    session: str | None,
    written: bool,
    lines: list[str],
    beats: int,
    acks: list[str],
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    monkeypatch.setattr(tray_host, "popen_hidden", lambda *_, **__: _FakeHost("READY", *lines))
    monkeypatch.setattr(tray_host, "_write_state", lambda *_, **__: written)
    view = TrayView("connected", False, "UniOver", screen_session=session)
    indicator = _Beats()
    acknowledged: list[str] = []

    def acknowledge(viewing: str) -> None:
        # O carimbo vem antes: quem espera a confirmação exige a bandeja viva.
        assert indicator.calls[-1:] == ["beat"]
        acknowledged.append(viewing)

    monkeypatch.setattr(tray_host, "acknowledge_viewing", acknowledge)

    class Controller:
        def refresh(self) -> TrayView:
            return view

        def handle(self, action: str, screen_session: str | None = None) -> None:
            pass

    assert not tray_host.run_host(
        tmp_path,
        tmp_path,
        view,
        cast(TrayController, Controller()),
        lambda _: None,
        lambda _: None,
        lambda *_: None,
        cast(TrayBeat, indicator),
    )
    assert indicator.calls == ["beat"] * beats + ["suspend"]
    assert acknowledged == acks


def test_a_stream_of_confirmations_does_not_hold_back_the_refresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    monkeypatch.setattr(tray_host, "_REFRESH_SECONDS", 0.05)
    refreshed = threading.Event()
    refreshes: list[None] = []

    def chatter() -> Iterator[str]:
        yield "READY\n"
        deadline = time.monotonic() + 5
        # Mais rápidas que o intervalo de atualização, até a terceira volta acontecer.
        while not refreshed.is_set() and time.monotonic() < deadline:
            time.sleep(0.005)
            yield "APPLIED \n"

    monkeypatch.setattr(tray_host, "popen_hidden", lambda *_, **__: _TalkingHost(chatter()))
    view = TrayView("connected", False, "UniOver")
    indicator = _Beats()

    class Controller:
        def refresh(self) -> TrayView:
            refreshes.append(None)
            if len(refreshes) == 3:
                refreshed.set()
            return view

        def handle(self, action: str, screen_session: str | None = None) -> None:
            pass

    assert not tray_host.run_host(
        tmp_path,
        tmp_path,
        view,
        cast(TrayController, Controller()),
        lambda _: None,
        lambda _: None,
        lambda *_: None,
        cast(TrayBeat, indicator),
    )
    assert refreshed.is_set()
    # E cada confirmação não vira uma regravação do estado.
    assert len(refreshes) < indicator.calls.count("beat")


def test_the_host_script_confirms_only_after_the_icon_took_the_state() -> None:
    script = tray_host.host_script().read_text(encoding="ascii")

    cleared = script.index("$script:lastState = ''\n            $view")
    icon = script.index("$icon.Icon = $replacement")
    applied = script.index("$script:lastState = $raw")
    confirmed = script.index("[Console]::Out.WriteLine('APPLIED ' + $script:viewing)")
    assert cleared < icon < applied < confirmed


def test_the_host_script_does_not_confirm_a_state_the_shell_refused() -> None:
    """`NotifyIcon.Icon` e `.Text` não dizem se o Windows aceitou: a chamada nativa diz, e só o
    estado aceito libera a confirmação."""
    script = tray_host.host_script().read_text(encoding="ascii")

    icon = script.index("$icon.Icon = $replacement")
    native = script.index(
        "if ([UniOverTrayNative]::ApplyIconAndTip($windowHandle, $iconId, $icon.Icon.Handle,"
        " $icon.Text)) {"
    )
    accepted = script.index("$script:lastState = $raw")
    pending = script.index("if ($raw -ne $script:lastState) { return }")
    confirmed = script.index("[Console]::Out.WriteLine('APPLIED ' + $script:viewing)")
    assert icon < native < accepted < pending < confirmed
    assert "Flags = NifIcon | NifTip" in script


@pytest.mark.parametrize("finished_at", [5.0, 14.0], ids=["lento", "carimbo-vencido"])
def test_a_slow_refresh_keeps_only_the_latest_confirmation_and_preserves_actions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, finished_at: float
) -> None:
    monkeypatch.setenv(DRILL_ENV, "1")
    now = 1.0
    monkeypatch.setattr(tray_host, "time", SimpleNamespace(monotonic=lambda: now))
    monkeypatch.setattr(pc_screen_presence, "tray_tick", lambda _kernel=None: round(now * 1000))
    monkeypatch.setattr(tray_host, "create_tray_wake_event", lambda: None)
    refresh_started = threading.Event()
    burst_read = threading.Event()
    view = TrayView("viewing", False, "UniOver", screen_session=_VIEW_ID)
    indicator = _Beats()
    acknowledged: list[str] = []
    monkeypatch.setattr(tray_host, "acknowledge_viewing", acknowledged.append)
    stops: list[Callable[[], None]] = []
    handled: list[tuple[str, str | None]] = []
    refreshes: list[float] = []

    def lines() -> Iterator[str]:
        nonlocal now
        yield "READY\n"
        yield "ACTION status\n"
        assert refresh_started.wait(2)
        now = 2.0
        for _ in range(20):
            yield f"APPLIED {_VIEW_ID}\n"
        yield f"APPLIED {_OLD_ID}\n"
        yield f"ACTION stop_screen {_VIEW_ID}\n"
        now = 3.0
        yield f"APPLIED {_VIEW_ID}\n"
        yield "ACTION quit\n"
        burst_read.set()

    class Controller:
        def refresh(self) -> TrayView:
            nonlocal now
            refreshes.append(now)
            if len(refreshes) == 1:
                refresh_started.set()
                assert burst_read.wait(2)
                now = finished_at
            return view

        def handle(self, action: str, session: str | None = None) -> None:
            handled.append((action, session))
            if action == "stop_screen":
                assert refreshes == [1.0]
                assert indicator.ticks == ([3000] if finished_at == 5.0 else [])
            if action == "quit":
                stops[0]()

    monkeypatch.setattr(tray_host, "popen_hidden", lambda *_, **__: _TalkingHost(lines()))
    assert tray_host.run_host(
        tmp_path,
        tmp_path,
        view,
        cast(TrayController, Controller()),
        stops.append,
        lambda _: None,
        lambda *_: None,
        cast(TrayBeat, indicator),
    )

    assert handled == [("status", None), ("stop_screen", _VIEW_ID), ("quit", None)]
    assert refreshes == [1.0, finished_at]
    assert indicator.ticks == ([3000] if finished_at == 5.0 else [])
    assert acknowledged == ([_VIEW_ID] if finished_at == 5.0 else [])


def test_the_ack_deadline_covers_slow_state_writes_even_without_a_wake_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = tray_host.host_script().read_text(encoding="ascii")
    interval_ms = int(script.partition("$timer.Interval = ")[2].splitlines()[0])
    # Sem o evento, a gravação em curso termina e só o próximo ciclo lê a nova visualização.
    state_write_ms = round(sum(tray_host._REPLACE_DELAYS) * 1000)
    latest_ack_ms = 2 * state_write_ms + round(tray_host._REFRESH_SECONDS * 1000) + interval_ms
    elapsed_ms = 0

    def wait(_event: object, timeout_ms: int) -> int:
        nonlocal elapsed_ms
        elapsed_ms += timeout_ms
        return 0 if elapsed_ms >= latest_ack_ms else 258

    monkeypatch.setattr(
        pc_screen_presence, "time", SimpleNamespace(monotonic=lambda: elapsed_ms / 1000)
    )
    monkeypatch.setattr(pc_screen_presence, "_tray_alive", lambda _kernel: True)

    assert pc_screen_presence._wait_for_ack(
        SimpleNamespace(WaitForSingleObject=wait), wintypes.HANDLE(1)
    )
    assert latest_ack_ms / 1000 < pc_screen_presence.TRAY_ACK_TIMEOUT_SECONDS
    assert pc_screen_presence.TRAY_ACK_TIMEOUT_SECONDS <= pc_screen_presence.TRAY_STALE_SECONDS


@windows_only
@pytest.mark.usefixtures("private_screen_names")
@pytest.mark.parametrize("visual", ["travado", "identificador-antigo", "confirma"])
def test_a_viewing_starts_only_after_the_visual_host_applies_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, visual: str
) -> None:
    """O caminho inteiro, sem processo nem ícone: a tela, o host Python e um visual falso que lê o
    arquivo de estado como o timer do script."""
    monkeypatch.setenv(DRILL_ENV, "1")
    monkeypatch.setattr(tray_host, "_REFRESH_SECONDS", 0.05)
    if visual != "confirma":
        monkeypatch.setattr(pc_screen_presence, "TRAY_ACK_TIMEOUT_SECONDS", 0.5)
    state = tmp_path / "runtime" / "tray-host-state.json"
    closed = threading.Event()
    received: set[str] = set()

    def timer() -> Iterator[str]:
        yield "READY\n"
        while not closed.wait(0.01):
            try:
                viewing = json.loads(state.read_text(encoding="utf-8"))["viewing"] or ""
            except OSError, ValueError:
                continue
            received.add(viewing)
            if not viewing or visual == "confirma":
                yield f"APPLIED {viewing}\n"
            elif visual == "identificador-antigo":
                yield f"APPLIED {_OLD_ID}\n"
            # travado: com a visualização no arquivo, nada mais sai.

    monkeypatch.setattr(tray_host, "popen_hidden", lambda *_, **__: _TalkingHost(timer(), closed))

    class Controller:
        def refresh(self) -> TrayView:
            return TrayView("connected", False, "UniOver", screen_session=viewing_session())

        def handle(self, action: str, screen_session: str | None = None) -> None:
            pass

    stops: list[Callable[[], None]] = []
    indicator = TrayBeat()
    host = threading.Thread(
        target=tray_host.run_host,
        args=(
            tmp_path,
            tmp_path,
            TrayView("connected", False, "UniOver"),
            cast(TrayController, Controller()),
            stops.append,
            lambda _: None,
            lambda *_: None,
            indicator,
        ),
        daemon=True,
    )
    host.start()
    try:
        deadline = time.monotonic() + 5
        while not tray_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert tray_alive()

        if visual == "confirma":
            with screen_indicator() as must_stop:
                assert not must_stop()
        else:
            with pytest.raises(TrayUnavailableError, match="não confirmou"):
                with screen_indicator():
                    pytest.fail("a visualização não pode começar sem o ícone aplicado")
        # A visualização chegou ao arquivo que o visual lê: a recusa é pela falta da confirmação.
        assert any(received)
    finally:
        for stop in stops:
            stop()
        host.join(timeout=10)
        closed.set()
        indicator.withdraw()
    assert not host.is_alive()


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
    view = TrayView("connected", False, "UniOver: conectado")
    assert tray_host._write_state(state, view, tmp_path)
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
            assert not tray_host._write_state(
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

        def handle(self, action: str, screen_session: str | None = None) -> None:
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


@pytest.mark.skipif(
    os.name != "nt" or os.environ.get("UNIOVER_TRAY_HOST_SMOKE") != "1",
    reason="ensaio visual opt-in no Windows interativo",
)
def test_real_host_omits_applied_after_icon_loss_and_registers_again(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    view = TrayView("connected", False, "Teste da bandeja", screen_session=_VIEW_ID)
    assert tray_host._write_state(state, view, assets_dir())
    host = tray_host.host_script().read_text(encoding="ascii")
    script = tmp_path / "tray-test.ps1"
    # Retira apenas o icone deste teste e simula o WinForms ainda acreditando que ele esta presente.
    tick = "$timer.add_Tick({"
    assert host.count(tick) == 1
    script.write_text(
        host.replace(
            tick,
            """$script:testTick = 0
$timer.add_Tick({
    $script:testTick++
    [Console]::Out.WriteLine("TICK $script:testTick")
    if ($script:testTick -eq 2) {
        $icon.Visible = $false
        $icon.GetType().GetField('visible', $fields).SetValue($icon, $true)
        $icon.GetType().GetField('added', $fields).SetValue($icon, $true)
    }
    if ($script:testTick -eq 4) { $context.ExitThread(); return }
""",
        ),
        encoding="ascii",
    )
    result = subprocess.run(  # noqa: S603 - executavel fixo, script do repositorio
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-StatePath",
            str(state),
            "-Probe",
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert "READY" in lines
    assert [line for line in lines if line.startswith(("TICK ", "APPLIED "))] == [
        "TICK 1",
        f"APPLIED {_VIEW_ID}",
        "TICK 2",
        "TICK 3",
        f"APPLIED {_VIEW_ID}",
        "TICK 4",
    ], result
