"""A marca da contagem de energia em `runtime`: sobrevive ao reinício e nunca levanta erro."""

from pathlib import Path

import pytest

from uniover_agent.adapters.power_countdown_file import POWER_COUNTDOWN_FILE, PowerCountdownFile


def test_a_marked_countdown_is_found_once_by_the_next_agent(tmp_path: Path) -> None:
    PowerCountdownFile(tmp_path, pid=lambda: 100).save("RESTART", "cid-1")
    following = PowerCountdownFile(tmp_path, pid=lambda: 200)
    assert following.take() == ("RESTART", "cid-1")
    assert following.take() is None
    assert not (tmp_path / POWER_COUNTDOWN_FILE).exists()


def test_a_mark_of_this_same_process_is_a_countdown_still_alive(tmp_path: Path) -> None:
    # O agente recomeça `run` no mesmo processo: o temporizador anterior ainda vai pedir ao Windows.
    PowerCountdownFile(tmp_path).save("SHUTDOWN", "cid-2")
    assert PowerCountdownFile(tmp_path).take() is None
    assert (tmp_path / POWER_COUNTDOWN_FILE).exists()


def test_a_cleared_countdown_is_not_found(tmp_path: Path) -> None:
    marker = PowerCountdownFile(tmp_path)
    marker.save("SHUTDOWN", "cid-2")
    marker.clear()
    marker.clear()  # sem marca, não é erro
    assert marker.take() is None


@pytest.mark.parametrize(
    "content",
    [
        "{",
        "[]",
        '{"action": "SLEEP", "id": "c"}',
        '{"action": 3, "id": "c"}',
        '{"action": "SHUTDOWN"}',
        '{"action": "SHUTDOWN", "id": ""}',
        "x" * 5000,
    ],
)
def test_a_strange_mark_is_dropped(tmp_path: Path, content: str) -> None:
    (tmp_path / POWER_COUNTDOWN_FILE).write_text(content, encoding="utf-8")
    assert PowerCountdownFile(tmp_path).take() is None
    assert not (tmp_path / POWER_COUNTDOWN_FILE).exists()


def test_a_disk_that_refuses_never_raises(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    blocked = tmp_path / "runtime"
    blocked.write_text("um arquivo no lugar da pasta", encoding="utf-8")
    marker = PowerCountdownFile(blocked)
    marker.save("SHUTDOWN", "cid-2")
    marker.clear()
    assert marker.take() is None
    assert "não consegui marcar a contagem" in caplog.text
