"""O aviso da contagem na tela do PC, com a caixa do Windows trocada: nenhuma janela de verdade."""

import sys
import threading
from datetime import datetime

import pytest

from uniover_agent.adapters import pc_power_notice
from uniover_agent.adapters.pc_power_notice import WindowsPowerNotice, notice_text

_NOW = datetime(2026, 11, 21, 21, 42, 40)


class FakeBox:
    """A caixa do Windows: guarda o que mostrou e espera a "pessoa" (o teste) responder."""

    def __init__(self) -> None:
        self.shown: list[tuple[str, str, int]] = []
        self.opened = threading.Event()
        self.answer: int | None = None
        self.answered = threading.Event()
        self.closed_titles: list[str] = []

    def __call__(self, text: str, title: str, flags: int) -> int:
        self.shown.append((text, title, flags))
        self.opened.set()
        assert self.answered.wait(5), "ninguém respondeu à caixa"
        assert self.answer is not None
        return self.answer

    def respond(self, answer: int) -> None:
        self.answer = answer
        self.answered.set()

    def close(self, title: str) -> bool:
        self.closed_titles.append(title)
        self.respond(1)  # o agente clica em "OK" por ela
        return True


def _wait_thread(name: str) -> None:
    for thread in threading.enumerate():
        if thread.name == name:
            thread.join(5)


def test_the_text_says_when_and_how_to_cancel() -> None:
    text = notice_text("SHUTDOWN", 30, datetime(2026, 11, 21, 21, 43, 10))
    assert "vai desligar às 21:43:10 (em 30 s)" in text
    assert "Cancelar aqui" in text
    assert '"Cancelar Desligamento" no app' in text
    restart = notice_text("RESTART", 10, datetime(2026, 11, 21, 8, 0, 5))
    assert "vai reiniciar às 08:00:05 (em 10 s)" in restart
    assert '"Cancelar Reinício"' in restart


def test_cancel_on_the_notice_cancels_the_countdown() -> None:
    box = FakeBox()
    cancelled: list[bool] = []
    notice = WindowsPowerNotice(box, box.close, now=lambda: _NOW)
    notice.show("RESTART", 30, lambda: cancelled.append(True))
    assert box.opened.wait(5)
    text, title, flags = box.shown[0]
    assert "vai reiniciar às 21:43:10 (em 30 s)" in text
    assert title.startswith("UniOver (")
    # OK e Cancelar, por cima de tudo, sem roubar o foco de quem digita.
    assert flags & 0xF == 0x1
    assert flags & 0x40000
    assert not flags & 0x10000
    box.respond(2)
    _wait_thread("uniover-power-notice")
    assert cancelled == [True]


def test_ok_only_closes_the_notice() -> None:
    box = FakeBox()
    cancelled: list[bool] = []
    notice = WindowsPowerNotice(box, box.close, now=lambda: _NOW)
    notice.show("SHUTDOWN", 30, lambda: cancelled.append(True))
    assert box.opened.wait(5)
    box.respond(1)
    _wait_thread("uniover-power-notice")
    assert cancelled == []


def test_closing_from_the_agent_never_counts_as_a_cancel() -> None:
    box = FakeBox()
    cancelled: list[bool] = []

    def close_with_cancel(title: str) -> bool:
        box.closed_titles.append(title)
        box.respond(2)  # mesmo que a caixa devolva "Cancelar", quem fechou foi o agente
        return True

    notice = WindowsPowerNotice(box, close_with_cancel, now=lambda: _NOW)
    notice.show("SHUTDOWN", 30, lambda: cancelled.append(True))
    assert box.opened.wait(5)
    notice.close()
    _wait_thread("uniover-power-notice-close")
    _wait_thread("uniover-power-notice")
    assert box.closed_titles == [box.shown[0][1]]
    assert cancelled == []


def test_close_without_a_notice_does_nothing() -> None:
    WindowsPowerNotice(lambda *args: 1, lambda title: False).close()


def test_a_broken_box_never_raises_to_the_countdown(caplog: pytest.LogCaptureFixture) -> None:
    def broken(text: str, title: str, flags: int) -> int:
        raise OSError("sem desktop")

    notice = WindowsPowerNotice(broken, lambda title: False, now=lambda: _NOW)
    notice.show("SHUTDOWN", 30, lambda: None)
    _wait_thread("uniover-power-notice")
    assert "não consegui mostrar o aviso da contagem" in caplog.text


def test_the_test_suite_never_opens_a_real_notice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(AssertionError, match="aviso de energia"):
        pc_power_notice._windows_message_box("texto", "UniOver", 0)
    with pytest.raises(AssertionError, match="aviso de energia"):
        pc_power_notice._windows_close("UniOver")


def test_outside_windows_there_is_no_notice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    cancelled: list[bool] = []
    WindowsPowerNotice().show("SHUTDOWN", 30, lambda: cancelled.append(True))
    assert cancelled == []
