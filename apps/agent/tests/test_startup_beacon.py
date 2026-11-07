"""Baliza de partida: o lançador e o supervisor avisam a API em cada marco, sem atrasar a partida.

Os scripts de verdade (Windows PowerShell 5.1) numa instalação falsa em pasta temporária
(`LOCALAPPDATA` trocado), com um servidor HTTP local no lugar da API: nada sai do computador.
"""

import json
import os
import re
import subprocess
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from .launcher_isolation import isolated_launcher
from .test_supervisor_guardrails import (
    CURRENT,
    POWERSHELL,
    RUNNER,
    SYSTEM32,
    TASKKILL,
    Pc,
    heartbeat,
    wait_for,
)

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

SLUG = "pc-de-teste"
ROUTE = f"/api/v1/devices/agents/{SLUG}/beacon"
LAUNCHER = RUNNER.with_name("launcher.ps1")
BLOCK_START = "# --- Baliza de partida"
BLOCK_END = "# --- Fim da baliza de partida"


class FakeApi:
    """Servidor local que só anota o que recebe (e responde 204, como a API)."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, object]]] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                size = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(size).decode("utf-8")
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = {"raw": raw}
                owner.requests.append((self.path, body))
                self.send_response(204)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def codes(self) -> list[str]:
        return [f"{body.get('stage')}.{body.get('code')}" for _path, body in self.requests]

    def count(self, code: str) -> int:
        return self.codes().count(code)


@pytest.fixture
def api() -> Iterator[FakeApi]:
    fake = FakeApi()
    fake.thread.start()
    try:
        yield fake
    finally:
        fake.server.shutdown()
        fake.server.server_close()


def configure(base: Path, api_url: str, slug: str = SLUG) -> None:
    (base / "config").mkdir(parents=True, exist_ok=True)
    (base / "config" / "agent.toml").write_text(
        f'api_url = "{api_url}"\nagent_id = "{slug}"\n', encoding="utf-8"
    )


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def test_the_agent_start_is_reported_with_only_stage_code_version_and_system(
    pc: Pc, api: FakeApi
) -> None:
    configure(pc.base, api.url)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: api.count("child_spawn.ok") >= 1, 40), pc.supervisor_log()
    path, body = api.requests[0]
    assert path == ROUTE
    assert body == {
        "v": 1,
        "stage": "child_spawn",
        "code": "ok",
        "ver": CURRENT,
        "os": "windows",
    }


def test_nothing_is_sent_without_a_configuration_or_with_a_bad_one(pc: Pc, api: FakeApi) -> None:
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():  # sem agent.toml
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(4)
    assert api.requests == []
    configure(pc.base, "https://user:senha@exemplo.invalid", SLUG)  # credencial no endereço
    pc.agents.unlink()
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(4)
    assert api.requests == []


def test_a_beacon_that_fails_never_delays_or_stops_the_start(pc: Pc) -> None:
    configure(pc.base, "http://127.0.0.1:9")  # nada escuta: a conexão é recusada
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    began = time.monotonic()
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: pc.starts() >= 1, 30), pc.supervisor_log()
        assert time.monotonic() - began < 25
        time.sleep(3)
        assert pc.starts() == 1


def test_the_exit_code_of_the_agent_is_reported_once_even_in_a_restart_loop(
    pc: Pc, api: FakeApi
) -> None:
    configure(pc.base, api.url)
    pc.uv(["exit /b 7"])
    with pc.running():
        assert wait_for(lambda: pc.starts() >= 3, 90), pc.supervisor_log()
        assert wait_for(lambda: api.count("child_exit.exit_7") >= 1, 40)
        time.sleep(3)
    # Várias quedas rápidas, uma baliza só por estágio+código; a de "abriu" não apaga a falha.
    assert api.count("child_exit.exit_7") == 1
    assert api.count("child_spawn.ok") <= 1


def test_three_quick_exits_in_a_row_are_reported_as_a_crash_loop(pc: Pc, api: FakeApi) -> None:
    configure(pc.base, api.url)
    pc.uv(["exit /b 1"])
    with pc.running():
        assert wait_for(lambda: api.count("child_exit.crash_loop") >= 1, 120), pc.supervisor_log()


def test_a_missing_uv_is_reported(pc: Pc, api: FakeApi) -> None:
    configure(pc.base, api.url)
    bare_path = f"{SYSTEM32};{SYSTEM32 / 'WindowsPowerShell' / 'v1.0'}"
    pc.uv(["exit /b 0"])
    with pc.running(PATH=bare_path):
        assert wait_for(lambda: api.count("supervisor.no_uv") >= 1, 40), pc.supervisor_log()
    assert pc.starts() == 0


def test_a_failed_sync_is_reported_and_a_full_disk_has_its_own_code(pc: Pc, api: FakeApi) -> None:
    configure(pc.base, api.url)
    pc.uv(["exit /b 0"], sync_lines=["echo erro 1>&2", "exit /b 1"])
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="1"):
        assert wait_for(lambda: api.count("supervisor.sync_failed") >= 1, 60), pc.supervisor_log()
    free = pc.base / "free-mb.txt"
    free.write_text("10", encoding="ascii")
    with pc.running(UNIOVER_SUPERVISOR_TEST_FREE_MB_FILE=str(free)):
        assert wait_for(lambda: api.count("supervisor.disk_full") >= 1, 60), pc.supervisor_log()


def test_the_beacon_state_file_keeps_a_new_supervisor_from_repeating_it(
    pc: Pc, api: FakeApi
) -> None:
    configure(pc.base, api.url)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with heartbeat(pc.alive), pc.running():
        assert wait_for(lambda: api.count("child_spawn.ok") >= 1, 40)
    assert (pc.runtime / "beacon.child_spawn.ok").is_file()
    pc.agents.unlink()
    with heartbeat(pc.alive), pc.running():  # outro supervisor, minutos antes da janela acabar
        assert wait_for(lambda: pc.starts() >= 1, 30)
        time.sleep(4)
    assert api.count("child_spawn.ok") == 1


def test_the_launcher_reports_that_it_started(tmp_path: Path, api: FakeApi) -> None:
    base = tmp_path / "UniOver"
    (base / "app" / "tools").mkdir(parents=True)
    (base / "app" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (base / "app" / ".version").write_text(CURRENT + "\n", encoding="ascii")
    (base / "app" / "tools" / "run-agent.ps1").write_text("Start-Sleep -Seconds 120\n", "ascii")
    configure(base, api.url)
    launcher = subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=os.environ | {"LOCALAPPDATA": str(tmp_path)},
        creationflags=0x08000000,
    )
    try:
        assert wait_for(lambda: api.count("bootstrap.ok") >= 1, 60)
    finally:
        subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
            [str(TASKKILL), "/PID", str(launcher.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=0x08000000,
        )
        launcher.wait(timeout=10)
    assert api.requests[0] == (
        ROUTE,
        {"v": 1, "stage": "bootstrap", "code": "ok", "ver": CURRENT, "os": "windows"},
    )


# --- o bloco é o mesmo nos dois scripts, e o endereço só vale se for seguro ---------------


def beacon_block(script: Path) -> str:
    text = script.read_text(encoding="ascii")
    start, end = text.index(BLOCK_START), text.index(BLOCK_END)
    return text[start:end]


def test_the_beacon_code_is_the_same_in_the_launcher_and_the_supervisor() -> None:
    assert beacon_block(LAUNCHER) == beacon_block(RUNNER)


def target_of(tmp_path: Path, toml: str) -> str:
    (tmp_path / "config").mkdir(exist_ok=True)
    (tmp_path / "config" / "agent.toml").write_text(toml, encoding="utf-8")
    block = tmp_path / "block.ps1"
    block.write_text(beacon_block(RUNNER), encoding="ascii")
    result = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema; trecho do repositório
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            f"$base = '{tmp_path}'; . '{block}'; $t = Get-BeaconTarget; "
            "if ($t) { $t } else { 'NONE' }",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        creationflags=0x08000000,
    )
    return result.stdout.strip()


@pytest.mark.parametrize(
    ("toml", "expected"),
    [
        (
            'api_url = "https://uniover.example"\nagent_id = "pc-de-casa"\n',
            "https://uniover.example/api/v1/devices/agents/pc-de-casa/beacon",
        ),
        (
            'api_url = "https://uniover.example/"\nagent_id = "pc-de-casa"\n',
            "https://uniover.example/api/v1/devices/agents/pc-de-casa/beacon",
        ),
        (
            'api_url = "http://localhost:5000"\nagent_id = "pc-de-casa"\n',
            "http://localhost:5000/api/v1/devices/agents/pc-de-casa/beacon",
        ),
        ('api_url = "http://uniover.example"\nagent_id = "pc-de-casa"\n', "NONE"),
        ('api_url = "https://uniover.example"\nagent_id = "PC de Casa"\n', "NONE"),
        ('api_url = "https://u:p@uniover.example"\nagent_id = "pc-de-casa"\n', "NONE"),
        ('api_url = "https://uniover.example/?x=1"\nagent_id = "pc-de-casa"\n', "NONE"),
        ('api_url = "https://uniover.example"\n', "NONE"),
        ('agent_id = "pc-de-casa"\n', "NONE"),
    ],
)
def test_the_target_comes_from_the_config_and_only_when_it_is_safe(
    tmp_path: Path, toml: str, expected: str
) -> None:
    assert target_of(tmp_path, toml) == expected


def test_the_exit_code_vocabulary_matches_what_the_api_accepts(tmp_path: Path) -> None:
    block = tmp_path / "block.ps1"
    block.write_text(beacon_block(RUNNER), encoding="ascii")
    script = (
        f". '{block}'; "
        "@(7, 0, -1, -1073741819, $null, 'x') | ForEach-Object { Get-BeaconExitCode $_ }"
    )
    result = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema; trecho do repositório
        [str(POWERSHELL), "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        creationflags=0x08000000,
    )
    codes = result.stdout.split()
    assert codes == [
        "exit_7",
        "exit_0",
        "exit_neg1",
        "exit_neg1073741819",
        "exit_unknown",
        "exit_unknown",
    ]
    # Os mesmos limites da API (AgentBeaconParser): letra minúscula primeiro, até 32 caracteres.
    assert all(re.fullmatch(r"[a-z][a-z0-9_]{1,31}", code) for code in codes)
