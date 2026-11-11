"""O ensaio de atualização: pacote da candidata, isolamento e apoio no processo filho."""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from types import ModuleType, SimpleNamespace

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


def test_offline_trial_restores_the_base_offer_before_normal_network_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rehearsal = drill.Drill(argparse.Namespace())
    rehearsal.root = tmp_path
    rehearsal.env = {"UNIOVER_UPDATE_SOURCE_URL": "local-test"}
    base_sha, offline_sha = "a" * 40, "b" * 40
    rehearsal.feed.offer(base_sha, None)
    monkeypatch.setattr(rehearsal, "version", lambda: base_sha)
    monkeypatch.setattr(rehearsal, "stop_everything", lambda: True)
    monkeypatch.setattr(rehearsal, "wait_ready", lambda: True)

    def offer(_label: str, _files: dict[str, bytes], sha: str, **_kwargs: object) -> bool:
        rehearsal.feed.offer(sha, b"candidate")
        return True

    monkeypatch.setattr(rehearsal, "offer", offer)
    assert rehearsal.refused_without_the_index(FILES, offline_sha)
    assert rehearsal.feed.sha == base_sha
    assert rehearsal.env == {"UNIOVER_UPDATE_SOURCE_URL": "local-test"}


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


def test_the_sync_failure_wrapper_fails_only_the_first_three_syncs(tmp_path: Path) -> None:
    wrapper = drill.sync_failure_wrapper()
    assert wrapper.isascii()
    assert 'if /I not "%~1"=="sync" goto real_uv' in wrapper
    assert 'if /I "%~3"=="%UNIOVER_DRILL_APP%" goto fail_sync' in wrapper
    assert 'if /I "%~4"=="%UNIOVER_DRILL_APP%" goto fail_sync' in wrapper
    assert "if %count% LEQ 3 exit /b 1" in wrapper
    assert '"%UNIOVER_DRILL_REAL_UV%" %*' in wrapper
    fake = tmp_path / "uv.cmd"
    fake.write_text(wrapper, encoding="ascii")
    real = tmp_path / "real-uv.cmd"
    real.write_text("@echo off\r\nexit /b 0\r\n", encoding="ascii")
    app = tmp_path / "app"
    counter = tmp_path / "sync-count.txt"
    env = {
        **os.environ,
        "UNIOVER_DRILL_APP": str(app),
        "UNIOVER_DRILL_SYNC_COUNT": str(counter),
        "UNIOVER_DRILL_REAL_UV": str(real),
    }

    def call(project: Path, frozen: bool = True) -> int:
        arguments = (
            ["sync", "--frozen", "--project", str(project)]
            if frozen
            else ["sync", "--project", str(project), "--quiet"]
        )
        done = subprocess.run(  # noqa: S603 - wrapper isolado na pasta temporaria do teste
            [
                os.environ["ComSpec"],
                "/d",
                "/c",
                str(fake),
                *arguments,
            ],
            env=env,
            check=False,
            capture_output=True,
            timeout=10,
        )
        return done.returncode

    assert call(tmp_path / "another-app") == 0
    assert not counter.exists()
    assert [call(app) for _ in range(4)] == [1, 1, 1, 0]
    assert counter.read_text(encoding="ascii").strip() == "4"
    counter.unlink()
    assert [call(app, frozen=False) for _ in range(4)] == [1, 1, 1, 0]


def test_the_offline_index_environment_forbids_downloads_and_hides_the_cache(
    tmp_path: Path,
) -> None:
    environment = drill.offline_index_env(tmp_path)
    assert environment["UV_OFFLINE"] == "1"
    # Cache vazio e dentro da pasta do ensaio: nada da instalação real nem do cache de quem roda.
    assert Path(environment["UV_CACHE_DIR"]).is_relative_to(tmp_path)
    assert not Path(environment["UV_CACHE_DIR"]).exists()


def test_the_offline_variant_is_another_commit_with_the_same_dependencies() -> None:
    offline = drill.offline_variant(FILES)
    assert drill.fake_sha(offline, "offline") != drill.fake_sha(FILES, "candidate")
    assert {k: v for k, v in offline.items() if k != "apps/agent/DRILL-OFFLINE.txt"} == FILES


def test_the_lock_packages_are_read_from_the_top_level_entries_only() -> None:
    lock = (
        b'version = 1\n\n[[package]]\nname = "zeroconf"\nversion = "1"\n'
        b'dependencies = [\n    { name = "ifaddr" },\n]\n\n'
        b'[[package]]\nname = "ifaddr"\nversion = "2"\n'
    )
    assert drill.lock_packages(lock) == {"zeroconf", "ifaddr"}


def proc(  # noqa: PLR0913 - horario e sessao por nome, so nos casos que importam
    pid: int, ppid: int, name: str, cmd: str, *, created: int = 100, session: int = 1
) -> object:
    return drill.Proc(pid, ppid, name, "", cmd, created, session)


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
    tracker = drill.Tracker(r"C:\t\ud1", r"C:\real")
    procs = [proc(10, 1, "powershell.exe", "x launcher.ps1"), proc(60, 99, "x.exe", "x.exe")]
    assert tracker.current(procs) == []


def test_the_tracker_never_includes_system_or_old_or_reused_processes() -> None:
    root = r"C:\t\ud1"
    procs = [
        proc(0, 0, "System Idle Process", "", created=1, session=0),
        proc(4, 0, "System", "", created=1, session=0),
        proc(8, 0, "smss.exe", "", created=101, session=0),
        proc(10, 1, "powershell.exe", f"{root}\\launcher.ps1", created=99),
        proc(11, 10, "python.exe", "python.exe", created=100),
        proc(20, 1, "powershell.exe", f"{root}\\launcher.ps1", created=100),
        proc(21, 20, "python.exe", "python.exe", created=101),
        proc(22, 20, "python.exe", "python.exe", created=99),
    ]
    tracker = drill.Tracker(root, r"C:\real", started=100)
    assert [p.pid for p in tracker.current(procs)] == [20, 21]


T0 = 100_000_000_000  # início do ensaio, em FILETIME


def test_a_process_whose_dead_parent_pid_was_reused_by_the_drill_is_not_the_drills() -> None:
    # O Command Palette do dono nasceu antes do ensaio e seu pai (PID 10680) morreu; depois o
    # Windows deu o PID 10680 a um processo do ensaio. Pela tabela de PID/pai, parecia filho dele.
    table = {
        10680: (1, "powershell.exe", T0 + 5_000_000),  # o PID reaproveitado, já do ensaio
        4772: (10680, "microsoft.cmdpal.ui.exe", T0 - 9_000_000_000),  # do dono, anterior
    }
    assert drill.drill_pids(table, {(10680, T0 + 5_000_000)}, T0) == {10680}
    # Mesmo que o dono abra o programa depois do início, o pai ainda é mais novo que o filho.
    table[4772] = (10680, "microsoft.cmdpal.ui.exe", T0 + 1_000_000)
    assert drill.drill_pids(table, {(10680, T0 + 5_000_000)}, T0) == {10680}


def test_the_agent_supervisor_and_launcher_descendants_are_still_the_drills() -> None:
    table = {
        10: (1, "powershell.exe", T0 + 1_000),  # lançador, achado pelo rastreador
        11: (10, "powershell.exe", T0 + 2_000),  # supervisor
        12: (11, "python.exe", T0 + 3_000),  # agente
        13: (12, "conhost.exe", T0 + 4_000),
        40: (1, "notepad.exe", T0 + 2_500),  # de fora
    }
    assert drill.drill_pids(table, {(10, T0 + 1_000)}, T0) == {10, 11, 12, 13}


def test_a_seed_is_matched_by_pid_and_creation_and_tolerates_the_cim_rounding() -> None:
    table = {10: (1, "powershell.exe", T0 + 1_005)}
    assert drill.drill_pids(table, {(10, T0 + 1_000)}, T0) == {10}  # 0,5 µs de arredondamento
    # Outro processo com o mesmo PID, criado bem depois, não é o semente.
    assert drill.drill_pids(table, {(10, T0 - 50_000_000)}, T0) == set()
    # Sem como ler a criação, nada é presumido.
    assert drill.drill_pids({10: (1, "powershell.exe", 0)}, {(10, T0 + 1_000)}, T0) == set()


def test_a_child_older_than_the_drill_is_never_adopted_even_by_a_live_parent() -> None:
    table = {
        10: (1, "powershell.exe", T0 + 1_000),
        11: (10, "python.exe", T0 - 1),  # anterior ao ensaio: só pode ser de outro
    }
    assert drill.drill_pids(table, {(10, T0 + 1_000)}, T0) == {10}


def test_a_live_child_of_a_tracked_parent_that_already_exited_is_still_the_drills() -> None:
    # O lançador abre o beacon (powershell escondido) com Process.Start e sai.
    seeds = {(10, T0 + 10_000_000)}
    child = {20: (10, "powershell.exe", T0 + 30_000_000)}
    assert drill.drill_pids(child, seeds, T0) == {20}
    # O PID do pai agora é de outro processo vivo, nascido depois do filho: o filho segue do ensaio.
    reused_later = {**child, 10: (1, "notepad.exe", T0 + 90_000_000)}
    assert drill.drill_pids(reused_later, seeds, T0) == {20}
    # O novo dono nasceu antes do filho: o filho é de outro programa.
    reused_earlier = {**child, 10: (1, "notepad.exe", T0 + 20_000_000)}
    assert drill.drill_pids(reused_earlier, seeds, T0) == set()
    # Filho nascido antes do pai, ou antes do ensaio, nunca é adotado.
    assert drill.drill_pids({20: (10, "x.exe", T0 + 5_000_000)}, seeds, T0) == set()
    assert drill.drill_pids({20: (10, "x.exe", T0 - 1)}, {(10, T0 - 50_000_000)}, T0) == set()


def test_a_child_of_an_exited_tracked_parent_takes_its_own_descendants_along() -> None:
    table = {
        20: (10, "powershell.exe", T0 + 3_000),
        21: (20, "conhost.exe", T0 + 4_000),
    }
    assert drill.drill_pids(table, {(10, T0 + 1_000)}, T0) == {20, 21}


def test_the_window_watch_flags_a_window_of_the_beacon_whose_launcher_already_exited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    table = {20: (10, "powershell.exe", T0 + 3_000)}  # o lançador (PID 10) não existe mais
    monkeypatch.setattr(drill, "visible_windows", lambda: [])
    watch = drill.WindowWatch(T0)
    watch.track({(10, T0 + 1_000)})
    watch.track(set())  # o rastreador já não o vê vivo; a lembrança fica
    monkeypatch.setattr(drill, "process_table", lambda: table)
    monkeypatch.setattr(drill, "visible_windows", lambda: [(1, 20, "ConsoleWindowClass", "beacon")])
    watch.sample()
    assert watch.offenders == {(20, "ConsoleWindowClass", "beacon"): "powershell.exe"}
    assert watch.lost_reference == []


def test_the_watch_records_a_lost_reference_only_when_tracked_pids_exist_without_a_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(drill, "visible_windows", lambda: [])
    watch = drill.WindowWatch(T0)
    watch.track({(10, T0 + 1_000)})
    monkeypatch.setattr(drill, "process_table", lambda: {10: (1, "powershell.exe", T0 + 1_001)})
    watch.sample()
    assert watch.lost_reference == []  # casou
    monkeypatch.setattr(drill, "process_table", lambda: {})
    watch.sample()
    assert watch.lost_reference == []  # saiu: não é perda de referência
    reused = {10: (1, "notepad.exe", T0 + 90_000_000)}
    monkeypatch.setattr(drill, "process_table", lambda: reused)
    watch.sample()  # o PID foi reaproveitado por um processo mais novo: o rastreado saiu
    assert watch.lost_reference == []
    monkeypatch.setattr(drill, "process_table", lambda: {10: (1, "powershell.exe", 0)})
    watch.sample()  # o PID existe, mas a criação ficou ilegível
    assert len(watch.lost_reference) == 1
    assert "pid 10" in watch.lost_reference[0]


def test_the_window_watch_flags_the_supervisor_window_but_not_the_owners_program(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    table = {
        10680: (1, "powershell.exe", T0 + 5_000_000),
        11: (10680, "powershell.exe", T0 + 6_000_000),  # supervisor do ensaio
        4772: (10680, "microsoft.cmdpal.ui.exe", T0 - 9_000_000_000),
    }
    windows = [
        (1, 11, "ConsoleWindowClass", "supervisor"),
        (2, 4772, "WinUIDesktopWin32WindowClass", "Paleta de Comandos"),
    ]
    monkeypatch.setattr(drill, "visible_windows", lambda: [])
    watch = drill.WindowWatch(T0)
    watch.seeds = {(10680, T0 + 5_000_000)}
    monkeypatch.setattr(drill, "process_table", lambda: table)
    monkeypatch.setattr(drill, "visible_windows", lambda: windows)
    watch.sample()
    assert watch.offenders == {(11, "ConsoleWindowClass", "supervisor"): "powershell.exe"}
    assert watch.suspects == {}


def test_the_child_environment_points_everything_at_the_temporary_folder(tmp_path: Path) -> None:
    base = {
        "LOCALAPPDATA": r"C:\real\Local",
        "APPDATA": r"C:\real\Roaming",
        "USERPROFILE": r"C:\real",
        "UNIOVER_CONFIG_FILE": r"C:\real\agent.toml",
        "UV_PROJECT_ENVIRONMENT": r"C:\real\venv",
        "UV_OFFLINE": "1",
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
    assert "UV_OFFLINE" not in env
    assert env["PYTHONPATH"] == str(tmp_path / "support")
    assert env["PYTHON_KEYRING_BACKEND"] == "drill_keyring.DrillKeyring"
    assert (env["UNIOVER_UPDATE_DRILL"], env["UNIOVER_UPDATE_SOURCE_URL"]) == (
        "1",
        "http://127.0.0.1:4321",
    )
    assert env["UV_CACHE_DIR"] == r"C:\cache"
    assert env["PATH"].split(os.pathsep) == [r"C:\uv", r"C:\Windows"]
    assert base["LOCALAPPDATA"] == r"C:\real\Local"  # o ambiente de quem chama não é alterado


def test_the_broken_candidate_is_checked_before_the_offline_index_scenario(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    class FakeDrill:
        def __init__(self, _args: object) -> None:
            self.verdict = drill.Verdict()
            self.base = tmp_path
            self.gateway = SimpleNamespace(handover_supported=True)

        def real_fingerprint(self) -> dict[str, object]:
            return {"processos reais": []}

        def prepare(self, _base_sha: str) -> None:
            events.append("prepare")

        def install_base(self, _base_sha: str) -> bool:
            return True

        def preflight(self, _base_sha: str) -> bool:
            return True

        def wait_ready(self) -> bool:
            return True

        def offer(self, label: str, *_args: object, **_kwargs: object) -> bool:
            # As trocas comuns (e a recusa) rodam com uma API que NÃO sabe a passagem.
            assert not self.gateway.handover_supported, label
            events.append(label)
            return True

        def refused_without_the_index(self, *_args: object) -> bool:
            events.append("sem indice")
            return True

        def recover_interrupted_swap(self, _sha: str) -> bool:
            events.append("queda entre as renomeacoes")
            return True

        def offer_handover(self, label: str, *_args: object) -> bool:
            # A passagem sem queda liga a API que a sabe (e as fases comuns a desligam de novo).
            self.gateway.handover_supported = True
            events.append(label)
            return True

        def rollback_after_sync_failure(self, _sha: str) -> bool:
            return True

        def stuck_update_is_interrupted(self) -> bool:
            events.append("atualizacao presa")
            return True

        def windows_check(self) -> None:
            return None

        def keep_evidence(self) -> None:
            raise AssertionError("o ensaio falso nao deveria reprovar")

        def cleanup(self) -> None:
            return None

    monkeypatch.setattr(drill, "Drill", FakeDrill)
    monkeypatch.setattr(drill, "resolve_base", lambda _requested: "b" * 40)
    monkeypatch.setattr(drill, "working_tree_files", lambda: dict(FILES))
    monkeypatch.setattr(drill, "ref_files", lambda _ref: {})
    monkeypatch.setattr(drill, "say", lambda _text="": None)
    monkeypatch.setattr(drill, "wait_until", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(drill.os, "name", "nt")

    assert drill.main([]) == 0
    broken = events.index("A. candidata quebrada (recusa, a base segue)")
    # Logo depois da recusa por código quebrado e antes de qualquer troca de versão.
    assert events.index("sem indice") == broken + 1
    assert events.index("sem indice") < events.index("B. base -> candidata")
    # A queda entre as renomeações é da troca clássica (a da base para a candidata): vem logo
    # depois dela e antes do primeiro ponteiro; a passagem sem queda vem depois da troca de reserva.
    names = [name for name in events if name.startswith(("B.", "C.", "C2.")) or "queda" in name]
    assert [name.split(" ")[0] for name in names] == ["B.", "queda", "C.", "C2."]


def test_stopping_the_drill_also_ends_an_update_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instance = object.__new__(drill.Drill)
    instance.launcher = None
    update = proc(40, 1, "uv.exe", r"uv.exe run --project C:\x\app uniover-agent self-update")
    snapshots = [[update], []]
    killed: list[int] = []

    monkeypatch.setattr(instance, "tree", lambda: snapshots.pop(0) if len(snapshots) > 1 else [])
    monkeypatch.setattr(instance, "kill", killed.append)
    monkeypatch.setattr(drill, "wait_until", lambda predicate, *_args: predicate())

    assert instance.stop_everything()
    assert killed == [40]


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
    for name in (
        "Write-Config",
        "Set-ConfigValues",
        "Move-Folder",
        "Get-MoveFailureReason",
        "Get-AgentSource",
        "Write-AgentLauncher",
    ):
        assert f"function {name}" in installer, name
    assert "'Move-Folder'" in drill.INSTALL_BASE


def test_only_long_lived_real_processes_count_for_the_untouched_check() -> None:
    now = 1_800_000_000.0
    filetime = int((now + 11_644_473_600) * 10_000_000)

    def made(name: str, age: float) -> object:
        return drill.Proc(1, 0, name, "", "", filetime - int(age * 10_000_000), 1)

    assert drill.is_transient(made("wscript.exe", 3600), now)  # o gancho da tarefa agendada
    assert drill.is_transient(made("powershell.exe", 5), now)  # lançador que acabou de nascer
    assert not drill.is_transient(made("powershell.exe", 3600), now)  # o supervisor de verdade
