# ruff: noqa: E501 - scripts de PowerShell em texto
"""Supervisor e lançador: nenhuma espera sem prazo e nenhum travamento sem quem reinicie.

O defeito de 05/11/2026: o supervisor ficou preso horas num `uv run ... self-update` sem filhos (disco
cheio), sem sinal de vida, e ninguém o reiniciou. Aqui os scripts de verdade (Windows PowerShell 5.1)
rodam numa instalação falsa em pasta temporária, com um `uv` falso que trava (`ping` longo), e se
confere: o filho é morto no prazo, o sinal de vida segue, o estado não fica em "atualizando" e um
supervisor mudo é reiniciado pelo lançador. Nada toca a instalação real; só se encerra o que o próprio
teste abriu (pela árvore do PID dele).
"""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from .launcher_isolation import isolated_launcher
from .test_launcher_recovery import POWERSHELL, TASKKILL, folder
from .test_supervisor_guardrails import CURRENT, RUNNER, Pc, wait_for

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

LAUNCHER_TOOLS = Path(__file__).parents[1] / "tools"


@pytest.fixture
def pc(tmp_path: Path) -> Pc:
    return Pc(tmp_path)


def status(pc: Pc) -> dict[str, object]:
    try:
        loaded: dict[str, object] = json.loads(
            (pc.runtime / "update-status.json").read_text(encoding="utf-8")
        )
    except OSError, ValueError:
        return {}
    return loaded


def pulse(pc: Pc) -> float:
    try:
        return (pc.runtime / "supervisor-alive").stat().st_mtime
    except OSError:
        return 0.0


def hung_children(marker: int) -> int:
    """Quantos `ping -n <marker>` (o filho preso do teste) ainda existem."""
    script = (
        "(Get-CimInstance Win32_Process -Filter \"Name='ping.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*-n {marker} *' }} | Measure-Object).Count"
    )
    done = subprocess.run(  # noqa: S603 - PowerShell do sistema; consulta só de leitura
        [str(POWERSHELL), "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
        creationflags=0x08000000,
    )
    return int(done.stdout.strip() or 0)


def test_a_hung_update_child_is_killed_at_the_deadline_while_the_pulse_keeps_moving(
    pc: Pc,
) -> None:
    marker = 617
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f"ping -n {marker} 127.0.0.1 > nul", "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS="8"):
        assert wait_for(lambda: status(pc).get("outcome") == "updating", 40), pc.supervisor_log()
        pulses: set[float] = set()
        end = time.monotonic() + 40
        while status(pc).get("outcome") == "updating" and time.monotonic() < end:
            pulses.add(pulse(pc))
            time.sleep(0.5)
        # O supervisor esperou o filho dando sinal de vida (o defeito era ficar mudo).
        assert len(pulses) >= 2, f"o sinal de vida parou durante a espera: {pulses}"
        assert status(pc)["outcome"] == "failed"
        assert "passou do prazo" in str(status(pc)["reason"])
        assert wait_for(lambda: "passou de 8 s" in pc.supervisor_log(), 5)
        assert any(i["kind"] == "update.timed_out" for i in pc.diagnostics())
        # Seguiu a vida: o agente subiu depois do prazo, e o filho preso não ficou para trás.
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert hung_children(marker) == 0, "o filho preso sobreviveu ao prazo"


def test_an_update_that_exits_without_recording_a_result_never_stays_updating(pc: Pc) -> None:
    # `uv` falso que termina com 0 e nada grava (o Python não conseguiu escrever, disco cheio).
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    with pc.running():
        assert wait_for(lambda: status(pc).get("outcome") == "failed", 40), pc.supervisor_log()
        assert "sem registrar o resultado" in str(status(pc)["reason"])


def test_a_nearly_full_disk_skips_the_update_and_says_why_without_running_the_child(
    pc: Pc,
) -> None:
    ran = pc.bin.parent / "update-ran"
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f'echo x>"{ran}"', "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: status(pc).get("outcome") == "failed", 40), pc.supervisor_log()
        assert "pouco espaco em disco" in str(status(pc)["reason"])
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert any(i["kind"] == "update.low_disk" for i in pc.diagnostics())
    assert not ran.exists(), "o filho de atualização rodou com o disco cheio"


def test_a_failed_sync_with_a_nearly_full_disk_keeps_the_environment_and_starts_the_agent(
    pc: Pc,
) -> None:
    venv = pc.runtime / "venv"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "Scripts" / "python.exe").write_bytes(b"")
    (venv / "keep-me").write_text("x", encoding="ascii")
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=["echo sem espaco 1>&2", "exit /b 1"],
    )
    with pc.running(UNIOVER_SUPERVISOR_MIN_FREE_MB="999999999"):
        assert wait_for(lambda: pc.starts() >= 1, 40), pc.supervisor_log()
        assert "mantenho o ambiente Python" in pc.supervisor_log()
    assert (venv / "keep-me").exists(), "o ambiente foi apagado com o disco cheio"


def test_a_hung_sync_is_killed_at_its_deadline_and_the_supervisor_goes_on(pc: Pc) -> None:
    marker = 623
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        sync_lines=[f"ping -n {marker} 127.0.0.1 > nul", "exit /b 0"],
    )
    with pc.running(UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS="4"):
        assert wait_for(lambda: "uv sync falhou (passou de 4 s" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for(lambda: hung_children(marker) == 0, 20)
        assert (pc.runtime / "supervisor-alive").exists()


def test_an_update_killed_mid_swap_without_app_asks_the_launcher_to_restore_it(pc: Pc) -> None:
    marker = 631
    pc.uv(
        ["ping -n 300 127.0.0.1 > nul", "exit /b 0"],
        update_lines=[f'rmdir /s /q "{pc.base / "app"}"', f"ping -n {marker} 127.0.0.1 > nul"],
    )
    with pc.running(UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS="6"):
        assert wait_for(lambda: "sumiu no meio da troca" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for((pc.runtime / "stop-reason.txt").exists, 10)
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "update"
        assert wait_for(lambda: hung_children(marker) == 0, 20)


def test_the_supervisor_brings_the_launcher_in_the_fixed_folder_up_to_date(pc: Pc) -> None:
    old = (LAUNCHER_TOOLS / "launcher.ps1").read_text(encoding="ascii") + "\r\n# versao antiga\r\n"
    (pc.base / "launcher.ps1").write_bytes(old.encode("ascii"))
    (pc.base / "app" / "tools").mkdir()
    fresh = (LAUNCHER_TOOLS / "launcher.ps1").read_bytes()
    (pc.base / "app" / "tools" / "launcher.ps1").write_bytes(fresh)
    pc.uv(["ping -n 300 127.0.0.1 > nul", "exit /b 0"])
    installed = pc.base / "launcher.ps1"

    def swapped() -> bool:
        # No instante da troca o Windows recusa a leitura por um momento.
        try:
            return installed.read_bytes() == fresh
        except OSError:
            return False

    with pc.running():
        assert wait_for(swapped, 30), pc.supervisor_log()


# --- Lançador: vigia o supervisor ---------------------------------------------------------------


def run_launcher(
    tmp_path: Path, stale: str, extra: dict[str, str] | None = None
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # noqa: S603 - Windows PowerShell do sistema; script do repositório
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(isolated_launcher(tmp_path)),
        ],
        env=os.environ
        | {
            "LOCALAPPDATA": str(tmp_path),
            "UNIOVER_TEST_MARKER": str(tmp_path / "started.txt"),
            "UNIOVER_LAUNCHER_STALE_SECONDS": stale,
        }
        | (extra or {}),
        creationflags=0x08000000,
    )


def stop(launcher: subprocess.Popen[bytes]) -> None:
    subprocess.run(  # noqa: S603 - taskkill do sistema, só para encerrar o que o teste abriu
        [str(TASKKILL), "/PID", str(launcher.pid), "/T", "/F"],
        check=False,
        capture_output=True,
        creationflags=0x08000000,
    )
    launcher.wait(timeout=10)


def counting_supervisor(*, touches: bool) -> str:
    """Supervisor de mentira: anota cada partida; o travado nunca dá sinal, o sadio o renova."""
    body = "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'x'\n"
    if touches:
        body += (
            "$alive = Join-Path $env:LOCALAPPDATA 'UniOver\\runtime\\supervisor-alive'\n"
            "while ($true) { [System.IO.File]::WriteAllText($alive, 'x'); Start-Sleep -Milliseconds 500 }\n"
        )
    else:
        # O texto cita `supervisor-alive`: é um supervisor que dá sinal (e, aqui, parou de dar).
        body = "# supervisor-alive\n" + body + "Start-Sleep -Seconds 300\n"
    return body


def starts(tmp_path: Path) -> int:
    marker = tmp_path / "started.txt"
    try:
        return len(marker.read_text(encoding="utf-8-sig").split())
    except OSError:  # inexistente, ou aberto para escrita naquele instante
        return 0


def test_a_live_supervisor_that_gave_no_sign_for_too_long_is_restarted_by_the_launcher(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=False), encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="4")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 2, 90), (tmp_path / "UniOver" / "logs").exists()
        log = (base / "logs" / "supervisor.log").read_text(encoding="utf-8")
        assert "sem sinal" in log and "vou reinicia-lo" in log
        kinds = (base / "runtime" / "diagnostics.jsonl").read_text(encoding="utf-8")
        assert "supervisor.unresponsive" in kinds
    finally:
        stop(launcher)


def test_a_supervisor_that_keeps_its_pulse_is_never_restarted_by_the_launcher(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (base / "runtime").mkdir()
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=True), encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="10")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        time.sleep(24)
        assert starts(tmp_path) == 1
    finally:
        stop(launcher)


def test_a_pc_that_slept_does_not_get_its_healthy_supervisor_killed(tmp_path: Path) -> None:
    # O relógio salta 100 s de uma vez (suspensão); o sinal do supervisor, que dormiu junto, parece
    # velho de 100 s contra um prazo de 4. Depois do salto o prazo recomeça: ninguém é reiniciado.
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (base / "runtime").mkdir()
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=True), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path, stale="4", extra={"UNIOVER_LAUNCHER_TEST_CLOCK_JUMP": "6:100"}
    )
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        log = base / "logs" / "supervisor.log"
        assert wait_for(lambda: log.exists() and "o relogio saltou" in log.read_text("utf-8"), 40)
        time.sleep(12)
        assert starts(tmp_path) == 1, "a suspensão do PC não é um supervisor travado"
    finally:
        stop(launcher)


def test_after_a_suspension_a_supervisor_that_stays_silent_is_still_restarted(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=False), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path, stale="4", extra={"UNIOVER_LAUNCHER_TEST_CLOCK_JUMP": "1:100"}
    )
    try:
        assert wait_for(lambda: starts(tmp_path) >= 2, 90)
        assert "o relogio saltou" in (base / "logs" / "supervisor.log").read_text("utf-8")
    finally:
        stop(launcher)


def test_the_outer_update_ceiling_is_above_every_inner_limit_and_below_the_stale_mark() -> None:
    # O teto externo (supervisor) nunca pode ser menor que a soma dos limites internos do
    # `self-update`, senão uma atualização lenta mas legítima é morta e recomeça do zero.
    import re  # noqa: PLC0415

    from uniover_agent.adapters import self_update as update  # noqa: PLC0415
    from uniover_agent.core.update_report import UPDATING_STALE_AFTER  # noqa: PLC0415

    script = RUNNER.read_text(encoding="utf-8")
    found = re.search(r"UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS'\s+(\d+)", script)
    assert found is not None
    ceiling = float(found.group(1))
    margin = 300.0
    assert ceiling >= update.WORST_CASE_SECONDS + margin
    assert ceiling < UPDATING_STALE_AFTER.total_seconds()
    # Os limites internos são os que quem executa de fato usa.
    assert update.run_uv_sync.__kwdefaults__ is not None
    assert update.run_uv_sync.__kwdefaults__["pause"] == update.SYNC_PAUSE_SECONDS


def test_the_launcher_does_not_start_another_supervisor_while_the_old_one_will_not_die(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=False), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path,
        stale="3",
        extra={"UNIOVER_LAUNCHER_TEST_KILL_FAILS": "1", "UNIOVER_LAUNCHER_KILL_WAIT_MS": "500"},
    )
    try:
        log = base / "logs" / "supervisor.log"
        assert wait_for(
            lambda: log.exists() and "nao consegui encerrar o supervisor" in log.read_text("utf-8"),
            90,
        )
        time.sleep(8)
        assert starts(tmp_path) == 1, "outro supervisor subiu com o antigo ainda vivo"
    finally:
        stop(launcher)


def legacy_supervisor(*, with_pulse_code: bool) -> str:
    """Supervisor de mentira, mudo; o novo se reconhece por `Invoke-Bounded` no texto."""
    body = counting_supervisor(touches=False)
    return ("# Invoke-Bounded\n" if with_pulse_code else "# versao antiga\n") + body


def test_an_old_style_supervisor_gets_the_longer_limit_and_a_new_one_does_not(
    tmp_path: Path,
) -> None:
    # O supervisor anterior bloqueia em `uv sync`/`self-update` sem dar sinal por muitos minutos:
    # o prazo de 15 min do novo mataria uma atualização lenta e legítima, em ciclo.
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        legacy_supervisor(with_pulse_code=False), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path, stale="3", extra={"UNIOVER_LAUNCHER_LEGACY_STALE_SECONDS": "60"}
    )
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        time.sleep(14)
        assert starts(tmp_path) == 1, "o supervisor antigo foi morto cedo demais"
    finally:
        stop(launcher)


def test_a_new_style_supervisor_keeps_the_short_limit(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        legacy_supervisor(with_pulse_code=True), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path, stale="3", extra={"UNIOVER_LAUNCHER_LEGACY_STALE_SECONDS": "600"}
    )
    try:
        assert wait_for(lambda: starts(tmp_path) >= 2, 90)
    finally:
        stop(launcher)


def test_repeated_restarts_back_off_instead_of_looping_at_once(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        legacy_supervisor(with_pulse_code=True), encoding="ascii"
    )
    launcher = run_launcher(
        tmp_path, stale="2", extra={"UNIOVER_LAUNCHER_RESTART_BASE_SECONDS": "2"}
    )
    try:
        log = base / "logs" / "supervisor.log"

        def waits() -> list[str]:
            if not log.exists():
                return []
            return [
                line.split("novo supervisor em ")[1].split(" s")[0]
                for line in log.read_text("utf-8").splitlines()
                if "novo supervisor em" in line
            ]

        assert wait_for(lambda: len(waits()) >= 3, 120), waits()
        assert waits()[:3] == ["2", "4", "8"], "a espera tem de dobrar a cada reinício seguido"
    finally:
        stop(launcher)


def test_a_supervisor_that_lost_the_mutex_does_not_send_the_launcher_to_the_fallback(
    tmp_path: Path,
) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text("exit 43\n", encoding="ascii")
    (base / "run-agent.fallback.ps1").write_text(
        "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'fallback'\n", encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="30")
    try:
        log = base / "logs" / "supervisor.log"
        assert wait_for(
            lambda: log.exists() and "ja ha um supervisor vivo" in log.read_text("utf-8"), 60
        )
        time.sleep(3)
        assert starts(tmp_path) == 0, "o fallback (copia antiga do supervisor) foi executado"
    finally:
        stop(launcher)


def spawn_decoy(script: Path) -> subprocess.Popen[bytes]:
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("Start-Sleep -Seconds 300\n", encoding="ascii")
    return subprocess.Popen(  # noqa: S603 - PowerShell do sistema; script do próprio teste
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ],
        creationflags=0x08000000,
    )


def busy_supervisor() -> str:
    """Supervisor novo que perde o mutex: anota a partida e sai com 43."""
    return "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'x'\nexit 43\n"


def test_a_mutex_holder_with_a_frozen_pulse_is_swept_again(tmp_path: Path) -> None:
    # O supervisor que segura a instalação sobrou da varredura da partida (o CIM falhou) e está
    # travado: esperar para sempre repetiria o incidente. Pulso parado (o mesmo carimbo velho em
    # duas voltas), a varredura é refeita e o diagnóstico fica registrado.
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(busy_supervisor(), encoding="ascii")
    runtime = base / "runtime"
    runtime.mkdir()
    alive = runtime / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    old = time.time() - 3600
    os.utime(alive, (old, old))
    launcher = run_launcher(tmp_path, stale="5", extra={"UNIOVER_LAUNCHER_BUSY_WAIT_SECONDS": "2"})
    decoy = None
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        # Nasce DEPOIS da varredura da partida: só a refeita pode pegá-lo.
        decoy = spawn_decoy(base / "run-agent.ps1")
        assert decoy.wait(timeout=90) is not None, "a varredura não foi refeita"
        log = (base / "logs" / "supervisor.log").read_text("utf-8")
        assert "refaco a varredura" in log
        # O mesmo carimbo velho em DUAS voltas: a primeira só anota (um PC que acabou de acordar).
        before = log.split("refaco a varredura")[0]
        assert before.count("ja ha um supervisor vivo") >= 2
        assert "supervisor.unresponsive" in (runtime / "diagnostics.jsonl").read_text("utf-8")
    finally:
        if decoy is not None and decoy.poll() is None:
            decoy.kill()
        stop(launcher)


def test_a_mutex_holder_with_a_fresh_pulse_is_left_alone(tmp_path: Path) -> None:
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(busy_supervisor(), encoding="ascii")
    runtime = base / "runtime"
    runtime.mkdir()
    alive = runtime / "supervisor-alive"
    alive.write_text("x", encoding="ascii")
    launcher = run_launcher(tmp_path, stale="5", extra={"UNIOVER_LAUNCHER_BUSY_WAIT_SECONDS": "2"})
    decoy = None
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        decoy = spawn_decoy(base / "run-agent.ps1")
        end = time.monotonic() + 15
        while time.monotonic() < end:
            alive.write_text("x", encoding="ascii")  # o dono do mutex está vivo
            time.sleep(0.5)
        assert decoy.poll() is None, "um supervisor vivo foi varrido"
    finally:
        if decoy is not None and decoy.poll() is None:
            decoy.kill()
        stop(launcher)


def test_a_fallback_that_stops_its_pulse_is_watched_and_restarted(tmp_path: Path) -> None:
    # Sem `app`, o lançador cai no fallback. Um que dá sinal (grava o `supervisor-alive`) e para é
    # vigiado como o supervisor.
    base = tmp_path / "UniOver"
    base.mkdir()
    (base / "run-agent.fallback.ps1").write_text(
        "# supervisor-alive\n"
        "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'fallback'\n"
        "Start-Sleep -Seconds 300\n",
        encoding="ascii",
    )
    launcher = run_launcher(tmp_path, stale="3")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 2, 120), "o fallback travado não foi reiniciado"
        log = (base / "logs" / "supervisor.log").read_text("utf-8")
        assert "sem sinal" in log
    finally:
        stop(launcher)


def test_a_healthy_fallback_that_never_writes_the_pulse_is_never_killed(tmp_path: Path) -> None:
    # O fallback é copiado uma vez só: numa instalação antiga ele nem sabe do `supervisor-alive`.
    # Vigiá-lo pelo pulso o mataria a cada prazo, mesmo sadio. Ele é esperado, como antes da vigia.
    base = tmp_path / "UniOver"
    base.mkdir()
    (base / "run-agent.fallback.ps1").write_text(
        "Add-Content -LiteralPath $env:UNIOVER_TEST_MARKER -Value 'fallback'\n"
        "Start-Sleep -Seconds 300\n",
        encoding="ascii",
    )
    launcher = run_launcher(tmp_path, stale="3")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        time.sleep(20)
        assert starts(tmp_path) == 1, "um fallback sadio e sem pulso foi morto"
        log = base / "logs" / "supervisor.log"
        assert not log.exists() or "sem sinal" not in log.read_text("utf-8")
    finally:
        stop(launcher)


def test_the_launcher_creates_the_pulse_file_before_the_supervisor_starts(tmp_path: Path) -> None:
    # Com o disco cheio o `Touch-Alive` só muda a data de um arquivo que já existe.
    base = tmp_path / "UniOver"
    app = folder(base, "app", "x", CURRENT)
    (app / "tools" / "run-agent.ps1").write_text(
        counting_supervisor(touches=False), encoding="ascii"
    )
    launcher = run_launcher(tmp_path, stale="300")
    try:
        assert wait_for(lambda: starts(tmp_path) >= 1, 60)
        assert (base / "runtime" / "supervisor-alive").exists()
    finally:
        stop(launcher)
