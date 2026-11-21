"""A marca da contagem de energia em `runtime`: sobrevive ao reinício e nunca levanta erro."""

from pathlib import Path

import pytest

from uniover_agent.adapters.power_countdown_file import (
    LOST_CAPACITY,
    POWER_COUNTDOWN_FILE,
    POWER_COUNTDOWN_LOST_FILE,
    PowerCountdownFile,
)


def test_a_marked_countdown_is_found_by_the_next_agent_until_the_api_confirms(
    tmp_path: Path,
) -> None:
    PowerCountdownFile(tmp_path, pid=lambda: 100).save("RESTART", "cid-1")
    following = PowerCountdownFile(tmp_path, pid=lambda: 200)
    assert following.take_lost() == [("RESTART", "cid-1")]
    # A marca saiu, mas a contagem perdida segue guardada até a API confirmar o aviso.
    assert not (tmp_path / POWER_COUNTDOWN_FILE).exists()
    assert following.take_lost() == [("RESTART", "cid-1")]
    assert PowerCountdownFile(tmp_path, pid=lambda: 300).take_lost() == [("RESTART", "cid-1")]
    following.confirm_lost("cid-1")
    assert following.take_lost() == []
    assert not (tmp_path / POWER_COUNTDOWN_LOST_FILE).exists()


def test_a_new_countdown_never_erases_a_lost_one_waiting_for_the_api(tmp_path: Path) -> None:
    PowerCountdownFile(tmp_path, pid=lambda: 100).save("SHUTDOWN", "cid-1")
    after_restart = PowerCountdownFile(tmp_path, pid=lambda: 200)
    assert after_restart.take_lost() == [("SHUTDOWN", "cid-1")]
    # Uma contagem nova regrava a marca antes de a API confirmar a perdida.
    after_restart.save("RESTART", "cid-2")
    after_restart.confirm_lost("outra")  # confirmação de outra coisa: nada sai
    assert PowerCountdownFile(tmp_path, pid=lambda: 300).take_lost() == [
        ("SHUTDOWN", "cid-1"),
        ("RESTART", "cid-2"),
    ]


def test_a_late_confirmation_never_erases_the_mark_of_a_live_countdown(tmp_path: Path) -> None:
    PowerCountdownFile(tmp_path, pid=lambda: 100).save("SHUTDOWN", "cid-1")
    marker = PowerCountdownFile(tmp_path, pid=lambda: 200)
    marker.take_lost()
    marker.save("RESTART", "cid-2")
    marker.confirm_lost("cid-1")
    assert (tmp_path / POWER_COUNTDOWN_FILE).exists(), "a marca da contagem viva fica"
    assert marker.take_lost() == []


def test_only_the_newest_lost_countdowns_are_kept(tmp_path: Path) -> None:
    for number in range(LOST_CAPACITY + 2):
        PowerCountdownFile(tmp_path, pid=lambda: 100).save("SHUTDOWN", f"cid-{number}")
        PowerCountdownFile(tmp_path, pid=lambda: 200).take_lost()
    lost = PowerCountdownFile(tmp_path, pid=lambda: 300).take_lost()
    assert [identifier for _, identifier in lost] == [
        f"cid-{number}" for number in range(2, LOST_CAPACITY + 2)
    ]


def test_a_mark_of_this_same_process_is_a_countdown_still_alive(tmp_path: Path) -> None:
    # O agente recomeça `run` no mesmo processo: o temporizador anterior ainda vai pedir ao Windows.
    PowerCountdownFile(tmp_path).save("SHUTDOWN", "cid-2")
    assert PowerCountdownFile(tmp_path).take_lost() == []
    assert (tmp_path / POWER_COUNTDOWN_FILE).exists()


def test_a_cleared_countdown_is_not_found(tmp_path: Path) -> None:
    marker = PowerCountdownFile(tmp_path)
    marker.save("SHUTDOWN", "cid-2")
    marker.clear()
    marker.clear()  # sem marca, não é erro
    assert marker.take_lost() == []


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
    assert PowerCountdownFile(tmp_path).take_lost() == []
    assert not (tmp_path / POWER_COUNTDOWN_FILE).exists()


@pytest.mark.parametrize("content", ["{", "{}", '[{"action": "SLEEP", "id": "c"}]', "x" * 5000])
def test_a_strange_lost_list_is_ignored(tmp_path: Path, content: str) -> None:
    (tmp_path / POWER_COUNTDOWN_LOST_FILE).write_text(content, encoding="utf-8")
    assert PowerCountdownFile(tmp_path).take_lost() == []


def test_a_disk_that_refuses_never_raises(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    blocked = tmp_path / "runtime"
    blocked.write_text("um arquivo no lugar da pasta", encoding="utf-8")
    marker = PowerCountdownFile(blocked)
    marker.save("SHUTDOWN", "cid-2")
    marker.clear()
    marker.confirm_lost("cid-2")
    assert marker.take_lost() == []
    assert "não consegui marcar a contagem" in caplog.text
