"""O que cada item do menu da bandeja faz: "Sair" fecha só o ícone, e o balão é só para falha."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from uniover_agent.adapters.tray_controller import (
    CLOSED_FLAG,
    NOTIFIED_FILE,
    TrayController,
    TrayEnv,
)
from uniover_agent.core.tray_model import TrayInputs
from uniover_agent.ports.diagnostics import Severity

NOW = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)


class World:
    """Os falsos do controlador: nada de Windows, de navegador nem de arquivo fora de `tmp_path`."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.inputs = TrayInputs(now=NOW, connected=True, since=NOW, power="on", tv_name="Sala")
        self.opened_urls: list[str] = []
        self.opened_files: list[Path] = []
        self.balloons: list[tuple[str, str]] = []
        self.records: list[tuple[str, Severity, str]] = []
        self.stopped = 0

    def env(self) -> TrayEnv:
        return TrayEnv(
            base=self.base,
            now=lambda: NOW,
            read_inputs=lambda _: self.inputs,
            open_url=self.opened_urls.append,
            open_file=self.opened_files.append,
            notify=lambda message, title: self.balloons.append((message, title)),
            stop=self._stop,
            record=lambda kind, severity, detail: self.records.append((kind, severity, detail)),
            site_url="https://uniover.example",
            version=lambda: "b" * 40,
        )

    def _stop(self) -> None:
        self.stopped += 1

    def controller(self) -> TrayController:
        return TrayController(self.env())

    def runtime_files(self) -> set[str]:
        runtime = self.base / "runtime"
        return {item.name for item in runtime.iterdir()} if runtime.exists() else set()


@pytest.fixture
def world(tmp_path: Path) -> World:
    return World(tmp_path)


def test_open_goes_to_the_site(world: World) -> None:
    world.controller().handle("open")

    assert world.opened_urls == ["https://uniover.example"]


def test_status_shows_a_balloon_with_the_summary(world: World) -> None:
    world.controller().handle("status")

    ((message, title),) = world.balloons
    assert title == "UniOver"
    assert message.splitlines()[:2] == ["Agente: conectado", "TV: Sala ligada"]
    assert message.endswith("Versão: bbbbbbbbbbbb")


def test_log_opens_the_file_or_says_there_is_none(world: World) -> None:
    controller = world.controller()
    controller.handle("log")
    assert world.opened_files == []
    assert world.balloons == [("Ainda não há registro para mostrar.", "UniOver")]

    (world.base / "logs").mkdir()
    (world.base / "logs" / "agent.log").write_text("x", encoding="utf-8")
    controller.handle("log")
    assert world.opened_files == [world.base / "logs" / "agent.log"]


def test_update_and_restart_leave_the_flags_the_supervisor_reads(world: World) -> None:
    controller = world.controller()
    controller.handle("update")
    controller.handle("restart")

    assert world.runtime_files() == {"update-now", "restart-now"}
    # Pedir atualização não abre balão: o aviso do Windows é só para falha.
    assert world.balloons == []


def test_quit_closes_only_the_icon_and_leaves_the_agent_alone(world: World) -> None:
    world.controller().handle("quit")

    assert world.stopped == 1
    # Só o sinal de "ícone fechado" (para o supervisor não reabri-lo): nada que reinicie,
    # atualize ou pare o agente.
    assert world.runtime_files() == {CLOSED_FLAG}
    assert world.balloons == []
    assert world.records == []


def test_a_failing_item_becomes_a_diagnostic_and_never_raises(world: World) -> None:
    def broken(_: str) -> None:
        raise OSError("sem navegador em C:\\Users\\alguem")

    env = world.env()
    env.open_url = broken
    TrayController(env).handle("open")

    ((kind, severity, detail),) = world.records
    assert (kind, severity) == ("tray.action_failed", "error")
    # O tipo e o lugar da falha, nunca a mensagem (que pode ter caminho de usuário).
    assert detail.startswith("open: OSError em ")
    assert "alguem" not in detail


def test_an_unknown_item_is_a_diagnostic_too(world: World) -> None:
    world.controller().handle("explodir")

    assert world.records[0][:2] == ("tray.action_failed", "error")


class TestUpdateFailureBalloon:
    @staticmethod
    def failed(world: World, when: datetime = NOW) -> None:
        world.inputs = TrayInputs(
            now=NOW, connected=True, since=NOW, update_outcome="failed", update_checked_at=when
        )

    def test_a_failure_opens_one_balloon_and_the_icon_gets_the_seal(self, world: World) -> None:
        self.failed(world)
        controller = world.controller()

        view = controller.refresh()
        controller.refresh()
        controller.refresh()

        assert view.attention
        assert world.balloons == [
            ("A atualização do UniOver falhou. Veja o registro.", "Falha na Atualização")
        ]

    def test_reopening_the_icon_does_not_repeat_the_same_balloon(self, world: World) -> None:
        self.failed(world)
        world.controller().refresh()
        assert (world.base / "runtime" / NOTIFIED_FILE).is_file()

        world.controller().refresh()

        assert len(world.balloons) == 1

    def test_a_new_failure_notifies_again(self, world: World) -> None:
        self.failed(world, NOW - timedelta(hours=3))
        controller = world.controller()
        controller.refresh()
        self.failed(world, NOW - timedelta(hours=1))
        controller.refresh()

        assert len(world.balloons) == 2

    def test_a_healthy_update_never_opens_a_balloon(self, world: World) -> None:
        world.inputs = TrayInputs(
            now=NOW, connected=True, since=NOW, update_outcome="updated", update_checked_at=NOW
        )
        world.controller().refresh()

        assert world.balloons == []

    def test_an_unwritable_memory_does_not_repeat_the_balloon_every_tick(
        self, world: World
    ) -> None:
        self.failed(world)
        # `runtime` é um arquivo: a lembrança em disco não pode ser gravada.
        (world.base / "runtime").write_text("nao e pasta", encoding="utf-8")
        controller = world.controller()

        controller.refresh()
        controller.refresh()

        assert len(world.balloons) == 1
