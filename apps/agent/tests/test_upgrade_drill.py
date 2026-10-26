"""O ensaio de atualização: pacote da candidata, isolamento e apoio no processo filho."""

import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from types import ModuleType

import httpx
import pytest

from uniover_agent.adapters.self_update import extract_agent

TOOLS = Path(__file__).resolve().parents[1] / "tools"
POWERSHELL = os.path.join(
    os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
)


def load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


drill = load("upgrade_drill", TOOLS / "upgrade_drill.py")

FILES = {
    "apps/agent/pyproject.toml": b"[project]\n",
    "apps/agent/tools/run-agent.ps1": b"# supervisor\n",
    "apps/agent/tools/launcher.ps1": b"# lancador\n",
    drill.MAIN_REL: b"print('oi')\n",
}


def test_the_candidate_zip_is_shaped_like_the_github_zip(tmp_path: Path) -> None:
    sha = drill.fake_sha(FILES, "candidate")
    archive = tmp_path / "candidate.zip"
    archive.write_bytes(drill.zip_bytes(FILES, sha))
    destination = tmp_path / "app"
    destination.mkdir()
    extract_agent(archive, destination)
    assert (destination / "pyproject.toml").is_file()
    assert (destination / "tools" / "run-agent.ps1").is_file()
    assert (destination / "tools" / "launcher.ps1").is_file()
    assert (destination / "src" / "uniover_agent" / "main.py").read_bytes() == b"print('oi')\n"


def test_the_local_working_tree_packages_with_the_agent_the_icon_and_the_scripts(
    tmp_path: Path,
) -> None:
    try:
        files = drill.working_tree_files()
    except OSError, subprocess.CalledProcessError:
        pytest.skip("sem git ou fora de um repositório")
    assert drill.ICON_REL in files
    assert "apps/agent/tools/run-agent.ps1" in files
    assert "apps/agent/tools/upgrade_drill.py" in files
    assert not any("/.venv/" in name or "__pycache__" in name for name in files)
    archive = tmp_path / "tree.zip"
    archive.write_bytes(drill.zip_bytes(files, drill.fake_sha(files, "candidate")))
    destination = tmp_path / "app"
    destination.mkdir()
    extract_agent(archive, destination)
    assert (destination / "tools" / "launcher.ps1").is_file()
    assert (destination / "assets" / "uniover.ico").is_file()


def test_a_committed_tree_packages_like_the_working_tree(tmp_path: Path) -> None:
    try:
        files = drill.ref_files("HEAD")
    except OSError, subprocess.CalledProcessError:
        pytest.skip("sem git ou fora de um repositório")
    assert drill.ICON_REL in files
    assert "apps/agent/tools/run-agent.ps1" in files
    archive = tmp_path / "ref.zip"
    archive.write_bytes(drill.zip_bytes(files, drill.fake_sha(files, "candidate")))
    destination = tmp_path / "app"
    destination.mkdir()
    extract_agent(archive, destination)
    assert (destination / "tools" / "launcher.ps1").is_file()
    assert (destination / "tools" / "run-agent.ps1").is_file()


def test_the_variants_have_other_contents_and_other_shas() -> None:
    nxt, broken = drill.next_variant(FILES), drill.broken_variant(FILES)
    shas = {
        drill.fake_sha(FILES, "candidate"),
        drill.fake_sha(nxt, "next"),
        drill.fake_sha(broken, "broken"),
    }
    assert len(shas) == 3
    assert all(drill.SHA.fullmatch(sha) for sha in shas)
    assert drill.fake_sha(FILES, "candidate") == drill.fake_sha(dict(FILES), "candidate")
    assert "apps/agent/DRILL-NEXT.txt" in nxt
    assert broken[drill.MAIN_REL].startswith(FILES[drill.MAIN_REL])
    assert b"raise RuntimeError" in broken[drill.MAIN_REL]
    assert {k: v for k, v in broken.items() if k != drill.MAIN_REL} == {
        k: v for k, v in FILES.items() if k != drill.MAIN_REL
    }


def test_the_sync_failure_wrapper_fails_only_the_first_three_syncs() -> None:
    wrapper = drill.sync_failure_wrapper()
    assert wrapper.isascii()
    assert 'if /I not "%~1"=="sync" goto real_uv' in wrapper
    assert 'if /I not "%~3"=="%UNIOVER_DRILL_APP%" goto real_uv' in wrapper
    assert "if %count% LEQ 3 exit /b 1" in wrapper
    assert '"%UNIOVER_DRILL_REAL_UV%" %*' in wrapper


def proc(pid: int, ppid: int, name: str, cmd: str, created: int = 100) -> object:
    return drill.Proc(pid, ppid, name, "", cmd, created)


@pytest.mark.parametrize(
    ("name", "cmd", "expected"),
    [
        ("powershell.exe", r"powershell.exe -File C:\x\UniOver\launcher.ps1", "launcher"),
        (
            "powershell.exe",
            r"powershell.exe -File C:\x\UniOver\app\tools\run-agent.ps1",
            "supervisor",
        ),
        ("uv.exe", r'uv.exe run --project "C:\x\app" uniover-agent run', "agent"),
        ("uniover-agent.exe", r'"C:\x\venv\Scripts\uniover-agent.exe" tray', "tray"),
        ("python.exe", r'"C:\x\python.exe" "C:\x\Scripts\uniover-agent.exe" run', "agent"),
        ("uv.exe", r'uv.exe run --project "C:\x\app" uniover-agent self-update', "update"),
        ("conhost.exe", r"\??\C:\Windows\system32\conhost.exe 0x4", "other"),
    ],
)
def test_the_role_of_each_process(name: str, cmd: str, expected: str) -> None:
    assert drill.role(proc(1, 0, name, cmd)) == expected


def test_the_tracker_takes_the_root_folder_and_its_descendants_but_never_the_real_install() -> None:
    root, real = r"C:\t\ud1", r"C:\u\AppData\Local\UniOver"
    procs = [
        proc(10, 1, "powershell.exe", rf"powershell.exe -File {root}\L\UniOver\launcher.ps1"),
        proc(11, 10, "powershell.exe", "powershell.exe -File outro.ps1"),
        proc(12, 11, "python.exe", "python.exe"),
        proc(20, 1, "uv.exe", rf'uv.exe run --project "{root}\L\UniOver\app"'),
        proc(30, 1, "uv.exe", rf'uv.exe run --project "{real}\app" uniover-agent run'),
        proc(31, 30, "python.exe", "python.exe filho do real"),
        proc(40, 1, "notepad.exe", "notepad.exe"),
        proc(50, 10, "python.exe", "python.exe do proprio ensaio"),
    ]
    tracker = drill.Tracker(root, real, protected={50})
    assert [p.pid for p in tracker.current(procs)] == [10, 11, 12, 20]


def test_the_tracker_ignores_a_process_that_is_not_a_descendant() -> None:
    tracker = drill.Tracker(r"C:\t\ud1", r"C:\real", launcher_pid=10)
    procs = [proc(10, 1, "powershell.exe", "x launcher.ps1"), proc(60, 99, "x.exe", "x.exe")]
    assert [p.pid for p in tracker.current(procs)] == [10]


def test_the_child_environment_points_everything_at_the_temporary_folder(tmp_path: Path) -> None:
    base = {
        "LOCALAPPDATA": r"C:\real\Local",
        "APPDATA": r"C:\real\Roaming",
        "USERPROFILE": r"C:\real",
        "UNIOVER_CONFIG_FILE": r"C:\real\agent.toml",
        "UV_PROJECT_ENVIRONMENT": r"C:\real\venv",
        "PYTHONPATH": r"C:\lixo",
        "VIRTUAL_ENV": str(tmp_path / ".venv"),
        "PATH": os.pathsep.join([str(tmp_path / ".venv" / "Scripts"), r"C:\Windows"]),
    }
    env = drill.build_env(
        base,
        root=tmp_path / "ud1",
        port=4321,
        uv_dir=r"C:\uv",
        uv_cache=r"C:\cache",
        uv_python=r"C:\py",
        support=tmp_path / "support",
    )
    for name in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"):
        assert Path(env[name]).is_relative_to(tmp_path / "ud1"), name
    assert "UNIOVER_CONFIG_FILE" not in env
    assert "UV_PROJECT_ENVIRONMENT" not in env
    assert "VIRTUAL_ENV" not in env
    assert env["PYTHONPATH"] == str(tmp_path / "support")
    assert env["PYTHON_KEYRING_BACKEND"] == "drill_keyring.DrillKeyring"
    assert (env["UNIOVER_UPDATE_DRILL"], env["UNIOVER_UPDATE_SOURCE_URL"]) == (
        "1",
        "http://127.0.0.1:4321",
    )
    assert env["UV_CACHE_DIR"] == r"C:\cache"
    assert env["PATH"].split(os.pathsep) == [r"C:\uv", r"C:\Windows"]
    assert base["LOCALAPPDATA"] == r"C:\real\Local"  # o ambiente de quem chama não é alterado


def test_the_local_feed_answers_the_commit_and_the_known_zips_only() -> None:
    feed = drill.Feed()
    server, port = drill.start_feed(feed)
    sha, other = "a" * 40, "b" * 40
    try:
        feed.offer(sha, b"PK-zip")
        base = f"http://127.0.0.1:{port}"
        assert json.loads(urllib.request.urlopen(f"{base}/commit").read()) == {"sha": sha}  # noqa: S310
        assert urllib.request.urlopen(f"{base}/archive/{sha}.zip").read() == b"PK-zip"  # noqa: S310
        with pytest.raises(urllib.error.HTTPError) as unknown:
            urllib.request.urlopen(f"{base}/archive/{other}.zip")  # noqa: S310
        assert unknown.value.code == 404
        assert feed.downloads(sha) == 1
    finally:
        server.shutdown()


def test_the_child_shim_redirects_only_the_two_github_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    def fake_get(url: str, **_: object) -> str:
        seen.append(str(url))
        return "ok"

    def fake_stream(method: str, url: str, **_: object) -> str:
        seen.append(str(url))
        return "ok"

    monkeypatch.setattr(httpx, "get", fake_get)
    monkeypatch.setattr(httpx, "stream", fake_stream)
    monkeypatch.setenv("UNIOVER_UPDATE_DRILL", "1")
    monkeypatch.setenv("UNIOVER_UPDATE_SOURCE_URL", "http://127.0.0.1:777")
    load("drill_sitecustomize", TOOLS / "upgrade_drill_support" / "sitecustomize.py")
    sha = "c" * 40
    httpx.get("https://api.github.com/repos/n33miaz/uniover/commits/main")
    httpx.stream("GET", f"https://github.com/n33miaz/uniover/archive/{sha}.zip")
    httpx.get("https://example.com/outra")
    assert seen == [
        "http://127.0.0.1:777/commit",
        f"http://127.0.0.1:777/archive/{sha}.zip",
        "https://example.com/outra",
    ]


def test_the_child_shim_is_inert_without_the_mode_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get(url: str, **_: object) -> str:
        return url

    monkeypatch.setattr(httpx, "get", fake_get)
    monkeypatch.setenv("UNIOVER_UPDATE_SOURCE_URL", "http://127.0.0.1:777")
    monkeypatch.delenv("UNIOVER_UPDATE_DRILL", raising=False)
    load("drill_sitecustomize", TOOLS / "upgrade_drill_support" / "sitecustomize.py")
    current: object = httpx.get
    assert current is fake_get


def test_the_fake_vault_hands_out_only_the_fake_token() -> None:
    module = load("drill_keyring", TOOLS / "upgrade_drill_support" / "drill_keyring.py")
    vault = module.DrillKeyring()
    assert vault.get_password("uniover-agent", "drill-agent") == module.TOKEN
    assert vault.get_password("outro-servico", "drill-agent") is None
    vault.set_password("uniover-agent", "x", "senha")
    assert vault.get_password("uniover-agent", "x") == module.TOKEN


def test_the_drill_scripts_are_ascii_and_parse_in_windows_powershell(tmp_path: Path) -> None:
    wrapper = TOOLS / "upgrade-drill.ps1"
    assert wrapper.read_bytes().isascii()
    assert drill.INSTALL_BASE.isascii()
    generated = tmp_path / "install-base.ps1"
    generated.write_text(drill.INSTALL_BASE, encoding="ascii")
    for script in (wrapper, generated):
        command = (
            "$e=$null;$t=$null;"
            "[void][System.Management.Automation.Language.Parser]"
            f"::ParseFile('{script}',[ref]$t,[ref]$e);"
            "if($e.Count){$e|ForEach-Object{$_.Message};exit 1}"
        )
        done = subprocess.run(  # noqa: S603 - executável do Windows e texto fixo
            [POWERSHELL, "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, (script, done.stdout)


def test_the_installer_functions_the_drill_borrows_still_exist() -> None:
    installer = (TOOLS / "install-windows.ps1").read_text(encoding="utf-8")
    for name in ("Write-Config", "Set-ConfigValues", "Get-AgentSource", "Write-AgentLauncher"):
        assert f"function {name}" in installer, name
