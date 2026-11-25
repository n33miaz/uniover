"""O que cada item do menu da bandeja faz: "Sair" fecha só o ícone, e o balão é só para falha."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from uniover_agent.adapters.tray_controller import (
    CLOSED_FLAG,
    NOTIFIED_FILE,
    VIEWING_MESSAGE,
    VIEWING_TITLE,
    TrayController,
    TrayEnv,
)
from uniover_agent.core.tray_model import VIEWING_RESUMES_WITHIN, TrayInputs
from uniover_agent.ports.diagnostics import Severity

NOW = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)
FIRST = "a" * 32
SECOND = "b" * 32
BALLOON = (VIEWING_MESSAGE, VIEWING_TITLE)


class World:
    """Os falsos do controlador: nada de Windows, de navegador nem de arquivo fora de `tmp_path`."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.inputs = TrayInputs(now=NOW, connected=True, since=NOW, power="on", tv_name="Sala")
        self.opened_urls: list[str] = []
        self.opened_files: list[Path] = []
        self.balloons: list[tuple[str, str]] = []
        # Falso: o ícone ainda não existe na bandeja (nada é entregue).
        self.deliver = True
        self.records: list[tuple[str, Severity, str]] = []
        self.stopped = 0
        self.now = NOW
        self.stop_requests: list[str] = []
        # Falso: aquela visualização já tinha acabado quando o pedido chegou.
        self.stop_reaches = True

    def env(self) -> TrayEnv:
        return TrayEnv(
            base=self.base,
            now=lambda: self.now,
            read_inputs=lambda _: self.inputs,
            open_url=self.opened_urls.append,
            open_file=self.opened_files.append,
            notify=self._notify,
            stop=self._stop,
            stop_screen=self._stop_screen,
            record=lambda kind, severity, detail: self.records.append((kind, severity, detail)),
            site_url="https://uniover.example",
            version=lambda: "b" * 40,
        )

    def _notify(self, message: str, title: str) -> bool:
        if self.deliver:
            self.balloons.append((message, title))
        return self.deliver

    def _stop(self) -> None:
        self.stopped += 1

    def _stop_screen(self, session: str) -> bool:
        self.stop_requests.append(session)
        return self.stop_reaches

    def viewing(self, session: str | None, after: float = 2) -> None:
        """Passa o tempo e diz quem está vendo na próxima leitura."""
        self.now += timedelta(seconds=after)
        self.inputs = replace(self.inputs, now=self.now, screen_session=session)

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


class TestViewingBalloon:
    def test_it_opens_once_when_viewing_starts(self, world: World) -> None:
        controller = world.controller()
        controller.refresh()
        assert world.balloons == []
        for _ in range(3):
            world.viewing(FIRST)
            controller.refresh()

        assert world.balloons == [BALLOON]

    def test_the_session_the_app_renews_is_the_same_viewing(self, world: World) -> None:
        controller = world.controller()
        # A primeira sessão dura a vida inteira dela, com a bandeja lendo a cada 2 s.
        for _ in range(45):
            world.viewing(FIRST)
            controller.refresh()
        world.viewing(None)
        controller.refresh()
        world.viewing(SECOND, after=5)
        controller.refresh()

        assert world.balloons == [BALLOON]

    def test_a_viewing_long_after_the_last_one_warns_again(self, world: World) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh()
        world.viewing(None)
        controller.refresh()
        world.viewing(SECOND, after=VIEWING_RESUMES_WITHIN.total_seconds() + 1)
        controller.refresh()

        assert world.balloons == [BALLOON, BALLOON]

    def test_it_waits_until_the_balloon_can_be_delivered(self, world: World) -> None:
        controller = world.controller()
        world.deliver = False
        world.viewing(FIRST)
        controller.refresh()
        world.deliver = True
        for _ in range(2):
            world.viewing(FIRST)
            controller.refresh()

        assert world.balloons == [BALLOON]

    def test_a_tray_that_opens_in_the_middle_stays_quiet(self, world: World) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh(announce=False)
        world.viewing(FIRST)
        controller.refresh()

        assert world.balloons == []

    def test_a_viewing_that_starts_right_after_the_icon_opens_warns(self, world: World) -> None:
        controller = world.controller()
        controller.refresh(announce=False)
        world.viewing(FIRST)
        controller.refresh()

        assert world.balloons == [BALLOON]


class TestStopSharingTheScreen:
    def test_it_asks_to_end_the_viewing_and_leaves_the_tray_and_agent_alone(
        self, world: World
    ) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh()

        controller.handle("stop_screen", FIRST)

        assert world.stop_requests == [FIRST]
        assert world.stopped == 0
        assert world.runtime_files() == set()

    def test_an_old_request_is_never_moved_to_the_current_viewing(self, world: World) -> None:
        controller = world.controller()
        world.viewing(SECOND)
        controller.refresh()

        controller.handle("stop_screen", FIRST)

        assert world.stop_requests == [FIRST]

    @pytest.mark.parametrize("session", [None, ""])
    def test_without_a_viewing_in_the_menu_nothing_is_asked(
        self, world: World, session: str | None
    ) -> None:
        controller = world.controller()
        world.viewing(SECOND)
        controller.refresh()

        controller.handle("stop_screen", session)

        assert world.stop_requests == []
        assert world.records == []

    def test_no_balloon_while_the_stopped_viewing_is_still_leaving(self, world: World) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh()
        controller.handle("stop_screen", FIRST)
        world.viewing(FIRST)
        controller.refresh()

        assert world.balloons == [BALLOON]

    def test_a_new_request_from_the_device_warns_at_once(self, world: World) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh()
        controller.handle("stop_screen", FIRST)
        world.viewing(None)
        controller.refresh()
        world.viewing(SECOND)
        controller.refresh()

        assert world.balloons == [BALLOON, BALLOON]

    def test_a_request_that_arrives_too_late_does_not_repeat_the_warning(
        self, world: World
    ) -> None:
        controller = world.controller()
        world.viewing(FIRST)
        controller.refresh()
        world.stop_reaches = False
        controller.handle("stop_screen", FIRST)
        world.viewing(SECOND)
        controller.refresh()

        # A seguinte emenda na anterior: continua sendo a mesma visualização.
        assert world.balloons == [BALLOON]


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

    def test_the_first_read_before_the_icon_exists_does_not_swallow_the_balloon(
        self, world: World
    ) -> None:
        """Falha no logon: o supervisor atualiza antes de o ícone abrir; só depois ele avisa."""
        self.failed(world)
        controller = world.controller()

        view = controller.refresh(announce=False)

        assert view.attention
        assert world.balloons == []
        assert not (world.base / "runtime" / NOTIFIED_FILE).exists()
        controller.refresh()
        assert len(world.balloons) == 1

    def test_a_balloon_that_could_not_be_shown_is_tried_again(self, world: World) -> None:
        self.failed(world)
        controller = world.controller()
        world.deliver = False

        controller.refresh()
        controller.refresh()
        assert world.balloons == []
        assert not (world.base / "runtime" / NOTIFIED_FILE).exists()

        world.deliver = True
        controller.refresh()
        controller.refresh()
        assert len(world.balloons) == 1

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
