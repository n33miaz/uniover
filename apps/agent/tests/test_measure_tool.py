"""A ferramenta de medição: só lê, nunca aperta tecla e calcula os números certos."""

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import TvSessionManager

TOOL = Path(__file__).resolve().parents[1] / "tools" / "measure_tv_session.py"


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("measure_tv_session", TOOL)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["measure_tv_session"] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def test_adb_only_runs_read_only_commands() -> None:
    allowed_shell = {"dumpsys", "cat", "ps"}
    forbidden = {"input", "keyevent", "am", "svc", "reboot", "setprop", "pm", "settings", "kill"}
    for name, command in tool.READ_ONLY_ADB.items():
        assert command[0] in {"logcat", "shell"}, name
        if command[0] == "shell":
            assert command[1] in allowed_shell, name
        assert not forbidden & set(command), name


def test_unknown_adb_command_is_refused() -> None:
    with pytest.raises(SystemExit, match="fora da lista"):
        tool.run_adb(Path("adb.exe"), "x:5555", "input")


def test_the_tool_never_sends_a_key() -> None:
    source = TOOL.read_text(encoding="utf-8")
    assert not re.search(r"send_key|launch_link|keyevent|KEYCODE_|\bPOWER\b.*send", source)
    # O texto cita as teclas de energia apenas para dizer que nunca saem.
    assert "nenhuma tecla de energia" in source


def test_missing_adb_is_reported(capsys: pytest.CaptureFixture[str]) -> None:
    assert (
        tool.main(
            ["memory", "--adb", "nao-existe.exe", "--serial", "x", "--host", "h", "--label", "a"]
        )
        == 1
    )
    assert "adb não encontrado" in capsys.readouterr().err


def test_percentiles_and_summary() -> None:
    values = [float(n) for n in range(1, 21)]
    summary = tool.summarize(values)
    assert summary["median"] == 10.5
    assert summary["p95"] == 19.0
    assert (summary["min"], summary["max"], summary["n"]) == (1.0, 20.0, 20.0)
    assert tool.percentile([5.0], 0.95) == 5.0


def test_kill_lines_are_distinct_and_the_same_death_is_not_counted_twice() -> None:
    log = "\n".join(
        [
            "10-19 10:00:01 tguard-kill-SystemApp com.google.android.tv.remote.service",
            "10-19 10:00:01 tguard-kill-SystemApp com.google.android.tv.remote.service",
            "10-19 10:00:09 outra coisa",
            "10-19 10:01:30 TGUARD-KILL again",
        ]
    )
    assert len(tool.kill_lines(log)) == 2
    assert tool.kill_lines("") == set()


def test_port_drops_count_only_open_to_closed_transitions() -> None:
    assert tool.count_port_drops([True, True, False, False, True, False, True]) == 2
    assert tool.count_port_drops([False, False]) == 0
    assert tool.count_port_drops([]) == 0


def test_memory_parsers() -> None:
    meminfo = "MemTotal:  940000 kB\nMemFree: 20000 kB\nMemAvailable:  48000 kB\nBuffers: 1 kB\n"
    assert tool.meminfo_fields(meminfo) == {
        "MemTotal": 940000,
        "MemFree": 20000,
        "MemAvailable": 48000,
    }
    ps = "  PID   RSS NAME\n  101  3200 adbd\n  202 51000 com.google.android.tv.remote.service\n"
    assert tool.process_rss_kb(ps, "adbd") == 3200
    assert tool.process_rss_kb(ps, "com.google.android.tv.remote.service") == 51000
    assert tool.process_rss_kb(ps, "inexistente") is None


def test_port_probe_reports_a_closed_port() -> None:
    assert tool.port_open("127.0.0.1", 1) is False


async def test_reconnect_measurement_reports_median_and_p95(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    remotes: list[FakeTvRemote] = []

    def fake_session(host: str, tv_name: str, client: str) -> TvSessionManager:
        remote = FakeTvRemote()
        remotes.append(remote)
        return TvSessionManager(FakeClock(), remote)

    monkeypatch.setattr(tool, "open_session", fake_session)
    monkeypatch.setattr(tool, "SETTLE_SECONDS", 0)
    out = tmp_path / "medicao.jsonl"
    args = argparse.Namespace(
        host="10.0.0.4", tv_name="tv", client_name="UniOver", repetitions=5, out=out
    )
    await tool.measure_reconnect(args)
    record = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert record["measurement"] == "reconnect"
    assert record["seconds"]["n"] == 5
    assert len(record["samples"]) == 5
    # Cada repetição abriu e fechou a sessão, sem enviar tecla alguma.
    assert len(remotes) == 5
    assert all(r.connects == 1 and r.sent == [] and not r.connected for r in remotes)
    assert "repetição 5/5" in capsys.readouterr().out


async def test_kill_measurement_collects_repeatedly_and_counts_distinct_lines(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    logs = iter(
        [
            "t1 tguard-kill antiga",  # já estava no buffer antes de medir
            "t1 tguard-kill antiga\nt2 tguard-kill nova",
            "t2 tguard-kill nova\nt3 tguard-kill outra",  # o buffer deu a volta: `antiga` saiu
            "t3 tguard-kill outra",
        ]
    )

    def fake_adb(adb: Path, serial: str, name: str) -> str:
        if name == "logcat_buffers":
            return "main: ring buffer is 256 KiB"
        return next(logs, "")

    port_states = {6466: iter([True, False, True]), 6467: iter([])}
    monkeypatch.setattr(tool, "run_adb", fake_adb)
    monkeypatch.setattr(tool, "port_open", lambda host, port: next(port_states[port], True))
    monkeypatch.setattr(tool, "SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(tool, "COLLECT_SECONDS", 0.01)
    out = tmp_path / "medicao.jsonl"
    args = argparse.Namespace(
        adb=Path("adb.exe"),
        serial="10.0.0.4:5555",
        host="10.0.0.4",
        minutes=0.003,
        session=False,
        tv_name="tv",
        client_name="UniOver",
        out=out,
    )
    await tool.measure_kills(args)
    record = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert record["measurement"] == "kills"
    assert record["session"] is False
    # `nova` e `outra` são novas; `antiga` já existia antes de começar.
    assert record["kills_in_log"] == 2
    assert record["port_drops"] == {"6466": 1, "6467": 0}
    assert record["log_buffers_before"] == "main: ring buffer is 256 KiB"
