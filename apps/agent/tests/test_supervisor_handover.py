r"""Supervisor `run-agent.ps1`: a passagem sem queda, o ponteiro da versão em uso e a volta atrás.

O laço de verdade (Windows PowerShell 5.1) com um `uv` falso numa instalação falsa. O agente antigo
é um processo que só sai quando o teste o manda (arquivo `old-stop`), e o novo, o de
`run --handover`,
faz o que o cenário pede: assume (manda o antigo sair), cai, não conecta ou diz que a API não sabe.
Os tempos curtos vêm das variáveis `UNIOVER_SUPERVISOR_*`, como nos outros testes do supervisor.
"""

import json
import re
import time
from pathlib import Path

import pytest

from uniover_agent.adapters.update_lock import update_lock

from .test_supervisor_guardrails import CURRENT, POWERSHELL, Pc, heartbeat, wait_for
from .test_update_lock import held_by_another_process

pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

NEW = "b" * 40


class HandoverPc(Pc):
    """`Pc` com um `uv` que sabe o `run --handover` e o `self-update --apply`."""

    def __init__(self, tmp_path: Path) -> None:
        super().__init__(tmp_path)
        self.old_stop = tmp_path / "old-stop"
        self.handovers = tmp_path / "passagens.txt"
        self.new_grew = tmp_path / "novo-vivo.txt"
        self.launched = tmp_path / "agente-ambiente.txt"
        # A versão de sempre (`app` + `runtime\\venv`) inteira: é para onde a volta atrás vai.
        (self.base / "app" / "tools").mkdir(parents=True, exist_ok=True)
        (self.base / "app" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (self.base / "app" / "tools" / "run-agent.ps1").write_text("# antigo\n", encoding="ascii")
        (self.runtime / "venv" / "Scripts").mkdir(parents=True)
        (self.runtime / "venv" / "Scripts" / "python.exe").write_bytes(b"")

    def fake(
        self,
        handover_lines: list[str],
        apply_lines: list[str] | None = None,
        *,
        old_obeys_exit_request: bool = False,
    ) -> None:
        """`old_obeys_exit_request`: o agente antigo atende o pedido de saída ordenada do supervisor
        (`runtime/handover-exit`), como o agente de hoje; sem isto ele o ignora, como uma versão
        que ainda não o conhece."""
        exit_request = (
            [
                r'if exist "%LOCALAPPDATA%\UniOver\runtime\handover-exit" ('
                r'copy /y "%LOCALAPPDATA%\UniOver\runtime\handover-exit" '
                r'"%UNIOVER_TEST_LAUNCHED%.exitreq" >nul & exit /b 0)'
            ]
            if old_obeys_exit_request
            else []
        )
        lines = [
            "@echo off",
            'if "%~1"=="--version" goto version',
            'if "%~1"=="sync" goto sync',
            'if "%~5"=="self-update" goto update',
            'if "%~5"=="tray" goto tray',
            'if "%~5"=="run" goto run',
            "exit /b 0",
            ":version",
            "exit /b 0",
            ":sync",
            "exit /b 0",
            ":update",
            'if "%~6"=="--apply" goto apply',
            "exit /b 0",
            ":apply",
            *(apply_lines or ["exit /b 0"]),
            ":tray",
            'echo x>>"%UNIOVER_TEST_TRAYS%"',
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
            ":run",
            'if "%~6"=="--handover" goto handover',
            'echo x>>"%UNIOVER_TEST_AGENTS%"',
            # O `>` cria o arquivo vazio antes de escrever: quem espera o arquivo existir leria
            # vazio. Grava ao lado e renomeia, já completo.
            "echo %UNIOVER_APP_DIR%^|%UV_PROJECT_ENVIRONMENT%^|%~3"
            ' >"%UNIOVER_TEST_LAUNCHED%.partial"',
            'move /y "%UNIOVER_TEST_LAUNCHED%.partial" "%UNIOVER_TEST_LAUNCHED%" >nul',
            ":oldwait",
            'if exist "%UNIOVER_TEST_OLDSTOP%" exit /b 0',
            *exit_request,
            "ping -n 2 127.0.0.1 > nul",
            "goto oldwait",
            ":handover",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%"',
            'echo %UNIOVER_APP_DIR%^|%UV_PROJECT_ENVIRONMENT%^|%~3 >"%UNIOVER_TEST_LAUNCHED%.new"',
            'echo %UNIOVER_HANDOVER_DEADLINE%>"%UNIOVER_TEST_LAUNCHED%.deadline"',
            *handover_lines,
            "",
        ]
        (self.bin / "uv.cmd").write_text("\n".join(lines), encoding="ascii")

    def stage(self, sha: str) -> None:
        """Uma versão preparada inteira (código, supervisor, marca da versão e ambiente)."""
        app = self.base / "app.staging" / sha
        (app / "tools").mkdir(parents=True)
        (app / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (app / "tools" / "run-agent.ps1").write_text("# novo\n", encoding="ascii")
        (app / ".version").write_text(sha + "\n", encoding="ascii")
        venv = self.runtime / f"venv-{sha}" / "Scripts"
        venv.mkdir(parents=True)
        (venv / "python.exe").write_bytes(b"")

    def mark_prepared(self, sha: str) -> None:
        body = {"sha": sha, "app": f"app.staging\\{sha}", "venv": f"runtime\\venv-{sha}"}
        (self.runtime / "prepared.json").write_text(json.dumps(body), encoding="utf-8")

    def write_pointer(self, current: str, *, with_legacy_previous: bool = False) -> None:
        """A versão preparada `current` em uso e, se pedido, a de sempre (`app`) como anterior."""
        body: dict[str, object] = {
            "v": 1,
            "current": {
                "sha": current,
                "app": f"app.staging\\{current}",
                "venv": f"runtime\\venv-{current}",
            },
        }
        if with_legacy_previous:
            body["previous"] = {"sha": None, "app": "app", "venv": "runtime\\venv"}
        (self.runtime / "current.json").write_text(json.dumps(body), encoding="utf-8")

    def pointer(self) -> dict[str, dict[str, str | None]]:
        loaded: dict[str, dict[str, str | None]] = json.loads(
            (self.runtime / "current.json").read_text(encoding="utf-8")
        )
        return loaded

    def environment(self, *, handover: bool = True) -> dict[str, str]:
        """O ambiente do supervisor. A passagem (`update_handover`) vem LIGADA aqui: o padrão da
        instalação é desligada, e o teste da reserva a desliga de propósito."""
        return {
            "UNIOVER_UPDATE_HANDOVER": "1" if handover else "0",
            "UNIOVER_TEST_OLDSTOP": str(self.old_stop),
            "UNIOVER_TEST_HANDOVERS": str(self.handovers),
            "UNIOVER_TEST_LAUNCHED": str(self.launched),
        }

    def handover_starts(self) -> int:
        text = self.handovers.read_text(encoding="ascii") if self.handovers.exists() else ""
        return len(text.splitlines())

    def trial(self) -> str | None:
        path = self.runtime / "update-trial.txt"
        return path.read_text(encoding="ascii") if path.exists() else None

    def write_trial_for_current(self) -> None:
        """A versão de sempre (`app`) está em prova, com a anterior guardada para onde voltar."""
        (self.runtime / "update-trial.txt").write_text(f"{CURRENT}|0", encoding="ascii")
        previous = self.base / "app.previous"
        (previous / "tools").mkdir(parents=True)
        (previous / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (previous / "tools" / "run-agent.ps1").write_text("# anterior\n", encoding="ascii")
        (previous / ".version").write_text("c" * 40 + "\n", encoding="ascii")

    def state(self) -> dict[str, object]:
        """`update-status.json` como está agora (vazio se ainda não existe)."""
        try:
            loaded = json.loads(self.text("update-status.json"))
        except json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def text(self, name: str) -> str:
        path = self.runtime / name
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""


@pytest.fixture
def pc(tmp_path: Path) -> HandoverPc:
    return HandoverPc(tmp_path)


def trigger_update(pc: HandoverPc, sha: str = NEW) -> None:
    """O dono pede "Atualizar agora" com uma versão já preparada (o `self-update` falso é no-op)."""
    pc.stage(sha)
    pc.mark_prepared(sha)
    (pc.runtime / "update-now").write_text("", encoding="ascii")


# ---- a passagem sem queda ----


def test_the_new_version_takes_over_while_the_old_one_serves_and_nothing_restarts(
    pc: HandoverPc,
) -> None:
    pc.fake(
        [
            # A API a fez dona e fechou a antiga: a antiga sai com 0 e a nova segue de pé.
            'echo x>"%UNIOVER_TEST_OLDSTOP%"',
            f"echo {READY} >{MARK_FILE}",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        asked_at = time.time()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        # O prazo absoluto que o agente novo recebe: o do supervisor (60 s) menos a margem (10 s).
        deadline = float(Path(str(pc.launched) + ".deadline").read_text(encoding="ascii"))
        assert asked_at + 45 <= deadline <= asked_at + 90
        # O ponteiro: a nova em uso e a antiga (o layout de sempre) para voltar atrás.
        pointer = pc.pointer()
        assert pointer["current"] == {
            "sha": NEW,
            "app": f"app.staging\\{NEW}",
            "venv": f"runtime\\venv-{NEW}",
        }
        assert pointer["previous"] == {"sha": None, "app": "app", "venv": "runtime\\venv"}
        assert pc.trial() == f"{NEW}|0"
        assert not (pc.runtime / "prepared.json").exists()
        assert not (pc.runtime / "update-now").exists()
        # A nova subiu com a pasta e o ambiente dela, sem sync implícito e só do filho.
        assert pc.handover_starts() == 1
        launched = Path(str(pc.launched) + ".new").read_text(encoding="ascii").strip()
        assert launched.startswith(f"{pc.base / 'app.staging' / NEW}|{pc.runtime / f'venv-{NEW}'}|")
        assert launched.endswith(f"{NEW}")
        state = json.loads(pc.text("update-status.json"))
        assert state["outcome"] == "updated"
        log = pc.supervisor_log()
        assert "passagem sem queda" in log
        assert "versao nova no ar sem queda" in log
        # Sem reinício: o laço nunca subiu um segundo agente nem pediu o `exit 42`.
        time.sleep(4)
        assert pc.starts() == 1
        assert not (pc.runtime / "stop-reason.txt").exists()
        assert "versao nova instalada" not in log
        assert (pc.runtime / "supervisor-alive").exists()


def test_an_old_one_that_exits_normally_still_requires_the_new_ready_mark(
    pc: HandoverPc,
) -> None:
    # A antiga pode sair sozinha pelo 4410 antes de o supervisor observar a marca. Isto não basta:
    # sem `readyAt` a candidata não chegou a servir e não pode ganhar o ponteiro nem a prova.
    pc.fake(
        [
            'echo x>"%UNIOVER_TEST_OLDSTOP%"',
            ":alive",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 2 127.0.0.1 > nul",
            "goto alive",
        ]
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_HANDOVER_ASK_SECONDS="1",
            UNIOVER_SUPERVISOR_HANDOVER_EXIT_SECONDS="1",
            UNIOVER_SUPERVISOR_HANDOVER_MARGIN_SECONDS="1",
            **pc.environment(),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "nao assumiu" in pc.supervisor_log(), 60), pc.supervisor_log()
        assert not (pc.runtime / "current.json").exists()
        assert pc.trial() is None
        assert NEW in (pc.runtime / ".deferred-versions").read_text(encoding="ascii")
        assert any(item["kind"] == "update.handover_failed" for item in pc.diagnostics())
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()


def test_the_window_of_a_handover_is_measured_when_the_new_one_is_ready(pc: HandoverPc) -> None:
    # O ponteiro só muda com `readyAt` da própria passagem; a janela abre aí e fecha na volta
    # seguinte, medindo os três tempos (a marca de outra passagem não vale: outro código).
    pc.fake(
        [
            'echo x>"%UNIOVER_TEST_OLDSTOP%"',
            f"echo {READY} >{MARK_FILE}",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(
            lambda: any(item["kind"] == "update.window" for item in pc.diagnostics()), 90
        ), pc.supervisor_log()
        item = next(i for i in pc.diagnostics() if i["kind"] == "update.window")
        assert item["detail"].startswith("mode=handover sha=" + NEW[:12])
        for field in ("new_start_to_connected_s", "connected_to_ready_s"):
            assert field in item["detail"]
        assert item["detail"].isascii()
        assert not (pc.runtime / "update-window.json").exists()


def outcome(pc: HandoverPc) -> object:
    """O desfecho em `update-status.json`; nulo enquanto o supervisor ainda grava o arquivo."""
    try:
        return pc.state().get("outcome")
    except OSError:
        return None


def test_a_new_version_that_crashes_after_the_old_one_left_is_blocked(
    pc: HandoverPc,
) -> None:
    # A saída espontânea da antiga não transforma uma queda da candidata em mero adiamento.
    pc.fake(['echo x>"%UNIOVER_TEST_OLDSTOP%"', "ping -n 2 127.0.0.1 > nul", "exit /b 9"])
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        blocked = pc.runtime / ".blocked-versions"
        # O supervisor bloqueia, registra o diagnóstico e só então grava o estado: com o arquivo do
        # bloqueio recém-criado, os outros dois ainda não estão lá (ou estão sendo gravados).
        assert wait_for(lambda: outcome(pc) == "blocked", 60), pc.supervisor_log()
        assert NEW in blocked.read_text(encoding="ascii")
        assert not (pc.runtime / "current.json").exists()
        assert any(item["kind"] == "update.rolled_back" for item in pc.diagnostics())


def test_a_new_version_that_crashes_on_start_is_blocked_and_the_old_one_never_stops(
    pc: HandoverPc,
) -> None:
    pc.fake(["exit /b 9"])
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        blocked = pc.runtime / ".blocked-versions"
        assert wait_for(blocked.exists, 60), pc.supervisor_log()
        assert NEW in blocked.read_text(encoding="ascii")
        assert not pc.old_stop.exists()
        assert not (pc.runtime / "current.json").exists()
        assert pc.trial() is None
        assert wait_for(
            lambda: any(i["kind"] == "update.rolled_back" for i in pc.diagnostics()), 10
        )
        assert wait_for(lambda: pc.state().get("outcome") == "blocked", 30), pc.supervisor_log()
        state = pc.state()
        assert state["blockedSha"] == NEW
        time.sleep(3)
        assert pc.starts() == 1


def test_a_new_version_that_never_connects_is_stopped_and_deferred_not_blocked(
    pc: HandoverPc,
) -> None:
    pc.fake(
        [
            ":alive",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 2 127.0.0.1 > nul",
            "goto alive",
        ]
    )
    alive = Path(str(pc.handovers) + ".alive")
    with (
        heartbeat(pc.alive),
        pc.running(UNIOVER_SUPERVISOR_HANDOVER_SECONDS="4", **pc.environment()),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "nao conectou" in pc.supervisor_log(), 60), pc.supervisor_log()
        # Sem queda: a antiga segue e o ponteiro não mudou. Não conectar no prazo é rede ou API
        # lentas (do PC, não da versão): adiada, nunca bloqueada.
        deferred = pc.runtime / ".deferred-versions"
        assert wait_for(deferred.exists, 10)
        assert NEW in deferred.read_text(encoding="ascii")
        assert not pc.old_stop.exists()
        assert not (pc.runtime / "current.json").exists()
        assert not (pc.runtime / ".blocked-versions").exists()
        assert pc.trial() is None
        assert wait_for(lambda: pc.state().get("outcome") == "failed", 30), pc.supervisor_log()
        assert wait_for(
            lambda: any(i["kind"] == "update.handover_failed" for i in pc.diagnostics()), 10
        )
        # O processo novo foi encerrado de verdade: o sinal de vida dele parou.
        time.sleep(2)
        size = alive.stat().st_size
        time.sleep(3)
        assert alive.stat().st_size == size
        assert pc.starts() == 1


CONNECTED = '{"token":"%UNIOVER_WINDOW_TOKEN%","connectedAt":"2026-11-10T12:00:00.000Z"}'
READY = (
    '{"token":"%UNIOVER_WINDOW_TOKEN%","connectedAt":"2026-11-10T12:00:00.000Z",'
    '"readyAt":"2026-11-10T12:00:03.000Z"}'
)
MARK_FILE = r'"%LOCALAPPDATA%\UniOver\runtime\connected.json"'


def test_the_old_one_is_stopped_when_the_new_one_connected_and_then_takes_over(
    pc: HandoverPc,
) -> None:
    # A nova conectou (a API confirmou: ela já a promoveu e mandou a antiga sair, que não reconecta)
    # mas a antiga não saiu no prazo: quem tem de servir é a nova, então a ANTIGA é derrubada. A
    # nova pega a trava, vira a dona e o ponteiro muda; matar a nova deixaria o PC sem agente.
    pc.fake(
        [
            f"echo {CONNECTED} >{MARK_FILE}",
            "ping -n 7 127.0.0.1 > nul",
            f"echo {READY} >{MARK_FILE}",
            ":alive",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 2 127.0.0.1 > nul",
            "goto alive",
        ]
    )
    alive = Path(str(pc.handovers) + ".alive")
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_HANDOVER_SECONDS="20",
            UNIOVER_SUPERVISOR_HANDOVER_ASK_SECONDS="1",
            UNIOVER_SUPERVISOR_HANDOVER_EXIT_SECONDS="2",
            **pc.environment(),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "antiga foi derrubada" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        # Antes de derrubar, o supervisor pediu a saída ordenada (esta antiga não a conhece).
        assert "pedi a saida ordenada" in pc.supervisor_log()
        assert "nao saiu 1 s depois" in pc.supervisor_log()
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert pc.pointer()["current"]["sha"] == NEW
        assert not (pc.runtime / ".blocked-versions").exists()
        assert not (pc.runtime / ".deferred-versions").exists()
        assert wait_for(
            lambda: any(i["kind"] == "update.handover_forced" for i in pc.diagnostics()), 10
        )
        # A nova segue de pé (é o agente agora) e a antiga não voltou: um só agente antigo lançado.
        size = alive.stat().st_size
        time.sleep(3)
        assert alive.stat().st_size > size
        assert pc.starts() == 1


def test_the_old_one_is_asked_to_leave_in_an_orderly_way_before_anything_is_stopped(
    pc: HandoverPc,
) -> None:
    # A nova conectou (a API a promoveu) e a antiga segue de pé: passado o tempo de a API a
    # mandar sair, o supervisor pede a saída ordenada, a antiga a atende e a passagem termina sem
    # derrubar ninguém. O pedido leva o código da passagem e some no fim.
    pc.fake(
        [
            f"echo {CONNECTED} >{MARK_FILE}",
            "ping -n 6 127.0.0.1 > nul",
            f"echo {READY} >{MARK_FILE}",
            ":alive",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 2 127.0.0.1 > nul",
            "goto alive",
        ],
        old_obeys_exit_request=True,
    )
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        log = pc.supervisor_log()
        assert "pedi a saida ordenada" in log
        assert "nao saiu 4 s" in log
        assert "antiga foi derrubada" not in log
        assert pc.pointer()["current"]["sha"] == NEW
        assert not (pc.runtime / "handover-exit").exists()
        assert not (pc.runtime / "handover-exit.tmp").exists()
        # O que a antiga leu: prefixo e código de 32 hexadecimais, sem quebra de linha.
        request = Path(str(pc.launched) + ".exitreq").read_text(encoding="ascii")
        assert re.fullmatch(r"handover-exit:[0-9a-f]{32}", request)
        assert not any(i["kind"] == "update.handover_forced" for i in pc.diagnostics())
        assert not (pc.runtime / ".blocked-versions").exists()
        assert not (pc.runtime / ".deferred-versions").exists()
        # Um só agente antigo foi lançado e ninguém o reiniciou.
        time.sleep(3)
        assert pc.starts() == 1


def test_the_request_to_leave_also_comes_before_the_stop_when_the_deadline_passes(
    pc: HandoverPc,
) -> None:
    # O prazo da passagem acaba antes do tempo de espera comum: o pedido sai nessa hora e a antiga
    # tem `HANDOVER_EXIT_SECONDS` para atendê-lo.
    pc.fake(
        [
            f"echo {CONNECTED} >{MARK_FILE}",
            "ping -n 6 127.0.0.1 > nul",
            f"echo {READY} >{MARK_FILE}",
            ":alive",
            'echo x>>"%UNIOVER_TEST_HANDOVERS%.alive"',
            "ping -n 2 127.0.0.1 > nul",
            "goto alive",
        ],
        old_obeys_exit_request=True,
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_HANDOVER_SECONDS="3",
            UNIOVER_SUPERVISOR_HANDOVER_EXIT_SECONDS="20",
            **pc.environment(),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        log = pc.supervisor_log()
        assert "a antiga saiu de forma ordenada" in log
        assert "antiga foi derrubada" not in log
        assert not any(i["kind"] == "update.handover_forced" for i in pc.diagnostics())
        assert pc.pointer()["current"]["sha"] == NEW
        assert not (pc.runtime / "handover-exit").exists()


def test_an_exit_request_left_by_a_dead_supervisor_is_dropped_on_start(pc: HandoverPc) -> None:
    pc.fake(["exit /b 0"])
    (pc.runtime / "handover-exit").write_text("a" * 32, encoding="ascii")
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        assert not (pc.runtime / "handover-exit").exists()


def test_a_new_one_that_connected_but_never_takes_over_is_stopped_and_deferred(
    pc: HandoverPc,
) -> None:
    # Derrubada a antiga, a nova não vira a dona a tempo: nada mais a segura. O agente reinicia pela
    # versão em uso e a versão fica adiada (não é bloqueada: o defeito pode ser do PC).
    pc.fake(
        [
            f"echo {CONNECTED} >{MARK_FILE}",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    with (
        heartbeat(pc.alive),
        pc.running(
            UNIOVER_SUPERVISOR_HANDOVER_SECONDS="3",
            UNIOVER_SUPERVISOR_HANDOVER_EXIT_SECONDS="2",
            UNIOVER_SUPERVISOR_HANDOVER_MARGIN_SECONDS="1",
            **pc.environment(),
        ),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "nao assumiu" in pc.supervisor_log(), 60), pc.supervisor_log()
        deferred = pc.runtime / ".deferred-versions"
        assert wait_for(deferred.exists, 10)
        assert NEW in deferred.read_text(encoding="ascii")
        assert not (pc.runtime / ".blocked-versions").exists()
        assert not (pc.runtime / "current.json").exists()
        assert pc.trial() is None
        # A antiga foi derrubada e o laço sobe o agente de novo pela versão em uso.
        assert wait_for(lambda: pc.starts() >= 2, 60), pc.supervisor_log()


def test_a_new_one_that_exits_after_connecting_gets_the_old_one_stopped_and_the_agent_restarted(
    pc: HandoverPc,
) -> None:
    # A nova conectou (a antiga já foi mandada sair e não reconecta) e cai com 5: só o reinício pela
    # versão em uso recoloca um agente no ar, e isso acontece na hora (não em minutos).
    pc.fake([f"echo {CONNECTED} >{MARK_FILE}", "ping -n 2 127.0.0.1 > nul", "exit /b 5"])
    with (
        heartbeat(pc.alive),
        pc.running(UNIOVER_SUPERVISOR_HANDOVER_OLD_GRACE_SECONDS="2", **pc.environment()),
    ):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(
            lambda: "o agente reinicia pela versao em uso" in pc.supervisor_log(), 60
        ), pc.supervisor_log()
        deferred = pc.runtime / ".deferred-versions"
        assert wait_for(deferred.exists, 10)
        assert NEW in deferred.read_text(encoding="ascii")
        assert not (pc.runtime / ".blocked-versions").exists()
        assert wait_for(lambda: pc.starts() >= 2, 30), pc.supervisor_log()
        assert not (pc.runtime / "current.json").exists()


def test_a_new_version_that_found_the_old_one_still_holding_the_lock_is_deferred(
    pc: HandoverPc,
) -> None:
    # Código 5: a anterior não largou a trava a tempo. Não é defeito da versão nova e também não
    # pode repetir a passagem a cada checagem: adiada.
    pc.fake(["exit /b 5"])
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        deferred = pc.runtime / ".deferred-versions"
        assert wait_for(deferred.exists, 60), pc.supervisor_log()
        assert NEW in deferred.read_text(encoding="ascii")
        assert not (pc.runtime / ".blocked-versions").exists()
        assert pc.trial() is None
        assert pc.starts() == 1


def test_an_api_that_cannot_hand_over_sends_the_update_down_the_reserve_path(
    pc: HandoverPc,
) -> None:
    # Código 6: a API não sabe passar a conexão. A troca vira a de sempre: o ponteiro é gravado
    # (o `--apply` do `self-update`, que espera a TV parar), o agente é encerrado e o supervisor
    # reinicia com a versão nova.
    pointer_body = (
        '{"v":1,"current":{"sha":"' + NEW + '","app":"app.staging\\\\' + NEW + '",'
        '"venv":"runtime\\\\venv-' + NEW + '"},"previous":{"sha":null,"app":"app",'
        '"venv":"runtime\\\\venv"}}'
    )
    pc.fake(
        ["exit /b 6"],
        apply_lines=[
            f'echo {pointer_body} >"%LOCALAPPDATA%\\UniOver\\runtime\\current.json"',
            "exit /b 0",
        ],
    )
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "caminho de reserva" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for(lambda: "versao nova instalada" in pc.supervisor_log(), 30), (
            pc.supervisor_log()
        )
        assert wait_for((pc.runtime / "stop-reason.txt").exists, 10)
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "update"
        assert pc.handover_starts() == 1
        assert wait_for((pc.runtime / "update-window.json").exists, 10)
        window = json.loads(pc.text("update-window.json"))
        assert window["mode"] == "restart"


@pytest.mark.parametrize("how", ["default", "env-off", "file-off"])
def test_with_the_handover_off_the_supervisor_never_starts_a_handover_process(
    pc: HandoverPc, how: str
) -> None:
    # `update_handover` desligada (o padrão): nem sobe `run --handover`. A troca é a de reserva:
    # ponteiro gravado por `self-update --apply` e reinício do agente.
    pointer_body = (
        '{"v":1,"current":{"sha":"' + NEW + '","app":"app.staging\\\\' + NEW + '",'
        '"venv":"runtime\\\\venv-' + NEW + '"},"previous":{"sha":null,"app":"app",'
        '"venv":"runtime\\\\venv"}}'
    )
    pc.fake(
        ["exit /b 0"],
        apply_lines=[
            f'echo {pointer_body} >"%LOCALAPPDATA%\\UniOver\\runtime\\current.json"',
            "exit /b 0",
        ],
    )
    environment = pc.environment()
    del environment["UNIOVER_UPDATE_HANDOVER"]
    if how == "env-off":
        environment["UNIOVER_UPDATE_HANDOVER"] = "0"
    if how == "file-off":
        (pc.base / "config").mkdir(exist_ok=True)
        (pc.base / "config" / "agent.toml").write_text(
            "update_handover = false\n", encoding="ascii"
        )
    with heartbeat(pc.alive), pc.running(**environment):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova instalada" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert pc.handover_starts() == 0
        assert "passagem sem queda" not in pc.supervisor_log()
        assert wait_for((pc.runtime / "stop-reason.txt").exists, 10)
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "update"


def test_the_handover_can_be_turned_on_in_the_config_file(pc: HandoverPc) -> None:
    pc.fake(
        [
            'echo x>"%UNIOVER_TEST_OLDSTOP%"',
            f"echo {READY} >{MARK_FILE}",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    environment = pc.environment()
    del environment["UNIOVER_UPDATE_HANDOVER"]
    (pc.base / "config").mkdir(exist_ok=True)
    (pc.base / "config" / "agent.toml").write_text("update_handover = true\n", encoding="ascii")
    with heartbeat(pc.alive), pc.running(**environment):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert pc.handover_starts() == 1


# ---- o ponteiro manda na versão em uso ----


def test_the_agent_starts_from_the_folder_and_environment_the_pointer_names(
    pc: HandoverPc,
) -> None:
    pc.fake(["exit /b 0"])
    pc.stage(NEW)
    pc.write_pointer(NEW)
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        assert wait_for(pc.launched.exists, 10)
        text = pc.launched.read_text(encoding="ascii").strip()
        staged = pc.base / "app.staging" / NEW
        assert text == f"{staged}|{pc.runtime / f'venv-{NEW}'}|{staged}"


def test_an_incomplete_current_version_falls_back_to_the_previous_one_and_says_so(
    pc: HandoverPc,
) -> None:
    pc.fake(["exit /b 0"])
    pc.stage(NEW)
    (pc.base / "app.staging" / NEW / "tools" / "run-agent.ps1").unlink()  # incompleta
    pc.write_pointer(NEW, with_legacy_previous=True)
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        assert wait_for(pc.launched.exists, 10)
        assert pc.launched.read_text(encoding="ascii").startswith(str(pc.base / "app") + "|")
        assert any(i["kind"] == "update.pointer_unusable" for i in pc.diagnostics())


@pytest.mark.parametrize("text", ["", "isto nao e json", '{"v":1}'])
def test_an_unreadable_pointer_means_the_layout_from_before(pc: HandoverPc, text: str) -> None:
    pc.fake(["exit /b 0"])
    (pc.runtime / "current.json").write_text(text, encoding="ascii")
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        assert wait_for(pc.launched.exists, 10)
        assert pc.launched.read_text(encoding="ascii").startswith(
            f"{pc.base / 'app'}|{pc.runtime / 'venv'}|"
        )


def test_a_pointer_with_a_path_outside_the_installation_is_ignored(pc: HandoverPc) -> None:
    pc.fake(["exit /b 0"])
    outside = pc.base.parent / "fora"
    (outside / "tools").mkdir(parents=True)
    (outside / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (outside / "tools" / "run-agent.ps1").write_text("# fora\n", encoding="ascii")
    body = {"v": 1, "current": {"sha": NEW, "app": "..\\fora", "venv": "runtime\\venv"}}
    (pc.runtime / "current.json").write_text(json.dumps(body), encoding="ascii")
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        assert wait_for(pc.launched.exists, 10)
        assert pc.launched.read_text(encoding="ascii").startswith(f"{pc.base / 'app'}|")


# ---- volta atrás com o ponteiro ----


def test_a_version_that_keeps_falling_in_proof_goes_back_by_rewriting_the_pointer(
    pc: HandoverPc,
) -> None:
    # Cai ao subir (sem passagem): três quedas em prova voltam para a anterior (o layout de sempre),
    # que fica intacta, e bloqueiam a que caiu. Nada é movido nem apagado.
    pc.fake(["exit /b 0"])
    pc.stage(NEW)
    pc.write_pointer(NEW, with_legacy_previous=True)
    (pc.runtime / "update-trial.txt").write_text(NEW + "|0", encoding="ascii")
    # O agente novo (que o supervisor sobe por `run` comum) cai logo; o da `app` de sempre fica.
    lines = (pc.bin / "uv.cmd").read_text(encoding="ascii")
    lines = lines.replace(
        'echo x>>"%UNIOVER_TEST_AGENTS%"',
        'echo x>>"%UNIOVER_TEST_AGENTS%"\r\n'
        'echo %UNIOVER_APP_DIR%|findstr /i /c:"app.staging" > nul && exit /b 3',
        1,
    )
    (pc.bin / "uv.cmd").write_text(lines, encoding="ascii")
    with pc.running(**pc.environment()):
        blocked = pc.runtime / ".blocked-versions"
        assert wait_for(blocked.exists, 300), pc.supervisor_log()
        assert NEW in blocked.read_text(encoding="ascii")
        assert wait_for(lambda: pc.pointer()["current"]["app"] == "app", 20)
        assert pc.trial() is None
        assert (pc.base / "app.staging" / NEW).is_dir()
        # O ponteiro é regravado antes do estado e do registro: espera os dois.
        assert wait_for(lambda: pc.state().get("outcome") == "rolled_back", 30), pc.supervisor_log()
        state = pc.state()
        assert state["blockedSha"] == NEW
        assert wait_for(lambda: "voltei para a versao anterior" in pc.supervisor_log(), 10)
        assert wait_for(
            lambda: any(i["kind"] == "update.rolled_back" for i in pc.diagnostics()), 10
        )
        # E o agente sobe de novo, agora da versão anterior.
        assert wait_for(
            lambda: (
                pc.launched.exists()
                and pc.launched.read_text(encoding="ascii").startswith(str(pc.base / "app") + "|")
            ),
            60,
        )


def test_the_owner_asking_to_go_back_rewrites_the_pointer_and_restarts(pc: HandoverPc) -> None:
    pc.fake(["exit /b 0"])
    pc.stage(NEW)
    pc.write_pointer(NEW, with_legacy_previous=True)
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        (pc.runtime / "rollback-now").write_text("", encoding="ascii")
        assert wait_for(lambda: pc.pointer()["current"]["app"] == "app", 60), pc.supervisor_log()
        blocked = pc.runtime / ".blocked-versions"
        assert wait_for(blocked.exists, 10)
        assert NEW in blocked.read_text(encoding="ascii")
        assert wait_for((pc.runtime / "stop-reason.txt").exists, 10)
        assert (pc.runtime / "stop-reason.txt").read_text(encoding="ascii") == "rollback"


# ---- agente que sai por disputa de identidade (codigo 7) ----


def test_an_agent_that_leaves_over_a_duplicate_identity_is_not_a_fall_of_the_version(
    tmp_path: Path,
) -> None:
    # O agente viu outro com a mesma identidade tomar a conexão duas vezes e saiu (código 7). Não
    # é queda da versão: não conta contra a prova (três quedas voltariam e BLOQUEARIAM uma versão
    # boa), não vira `process.exited` e a espera é a calma, sem laço de reinícios.
    pc = HandoverPc(tmp_path)
    pc.uv(["exit /b 7"])
    pc.write_trial_for_current()
    with pc.running(UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS="1", **pc.environment()):
        assert wait_for(lambda: pc.starts() >= 4, 120), pc.supervisor_log()
        assert wait_for(lambda: "mesma identidade" in pc.supervisor_log(), 10)
        assert pc.trial() == f"{CURRENT}|0"
        assert not (pc.runtime / ".blocked-versions").exists()
        assert not any(i["kind"] == "process.exited" for i in pc.diagnostics())
        assert (pc.base / "app" / ".version").read_text(encoding="ascii").strip() == CURRENT


# ---- a trava de atualização da instalação ----


def test_the_handover_runs_under_the_update_lock_and_marks_the_version_it_is_passing(
    pc: HandoverPc,
) -> None:
    # Durante a passagem a trava (a mesma do `self-update`) está com o supervisor e a versão em
    # passagem está marcada, para a poda não a apagar; as duas somem quando a passagem acaba.
    seen = pc.base.parent / "durante.txt"
    pc.fake(
        [
            r"set MARK=%LOCALAPPDATA%\UniOver\runtime\handover-sha.txt",
            'if exist "%MARK%" echo x>"%UNIOVER_TEST_DURING%"',
            'echo x>"%UNIOVER_TEST_OLDSTOP%"',
            f"echo {READY} >{MARK_FILE}",
            "ping -n 300 127.0.0.1 > nul",
            "exit /b 0",
        ]
    )
    with heartbeat(pc.alive), pc.running(UNIOVER_TEST_DURING=str(seen), **pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        trigger_update(pc)
        assert wait_for(lambda: "versao nova no ar sem queda" in pc.supervisor_log(), 60), (
            pc.supervisor_log()
        )
        assert wait_for(seen.exists, 10), "a marca da versão em passagem existia durante a passagem"
        assert wait_for(lambda: not (pc.runtime / "handover-sha.txt").exists(), 10)
        # A trava foi solta: outro processo a toma agora.
        with update_lock(pc.base) as taken:
            assert taken is True


def test_a_handover_waits_for_the_next_check_when_another_update_holds_the_lock(
    pc: HandoverPc,
) -> None:
    pc.fake(["exit /b 0"])
    with heartbeat(pc.alive), pc.running(**pc.environment()):
        assert wait_for(lambda: pc.starts() >= 1, 60), pc.supervisor_log()
        with held_by_another_process(pc.base):
            trigger_update(pc)
            assert wait_for(
                lambda: "outra atualizacao esta em andamento" in pc.supervisor_log(), 60
            ), pc.supervisor_log()
            # Nada foi iniciado, bloqueado, adiado nem trocado: o agente atual segue como estava.
            assert pc.handover_starts() == 0
            assert not (pc.runtime / "current.json").exists()
            assert not (pc.runtime / ".blocked-versions").exists()
            assert not (pc.runtime / ".deferred-versions").exists()
            assert pc.trial() is None
            assert (pc.runtime / "prepared.json").exists()
        assert pc.starts() == 1
