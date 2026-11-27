"""O "Parar de mostrar a tela": o pedido da bandeja chega ao processo da tela, e só à visualização
que ele nomeia."""

import asyncio
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest

from uniover_agent.adapters.pc_screen_presence import (
    request_screen_stop,
    screen_indicator,
    viewing_session,
)
from uniover_agent.adapters.pc_screen_worker import (
    CHUNK_BYTES,
    Capture,
    Offer,
    Probes,
    ScreenSession,
    Viewing,
)

from .test_pc_screen_worker import Channel, session

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="objetos nomeados do Windows")
_OFFER = Offer("oferta", "bilhete-de-teste", 10, 60)


def run_session(
    monkeypatch: pytest.MonkeyPatch, viewing: Viewing
) -> tuple[ScreenSession, Channel, asyncio.Task[None]]:
    """O processo da tela inteiro (`run`), com o par e o canal falsos e já autenticado."""
    screen, channel = session("192.168.1.6")
    screen.peer.close = AsyncMock()

    async def answer(_sdp: str) -> str:
        return "resposta"

    monkeypatch.setattr(screen, "answer", answer)

    def reply(_data: dict[str, str]) -> None:
        channel.message(k="auth", token="bilhete-de-teste")

    task = asyncio.create_task(screen.run(_OFFER, asyncio.Event(), reply, viewing, Probes()))
    return screen, channel, task


async def until(condition: Any) -> None:
    async with asyncio.timeout(2):
        while not condition():  # noqa: ASYNC110 - o objeto do Windows não avisa que surgiu
            await asyncio.sleep(0.01)


async def test_a_stop_request_ends_the_session_and_removes_the_indicator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked = asyncio.Event()
    shown: list[bool] = []

    @contextmanager
    def viewing() -> Iterator[Any]:
        shown.append(True)
        try:
            yield asked.is_set
        finally:
            shown.append(False)

    screen, channel, task = run_session(monkeypatch, viewing)
    await until(lambda: shown)
    await asyncio.sleep(0.3)
    assert not task.done()  # sem pedido, a sessão segue

    asked.set()
    await asyncio.wait_for(task, timeout=2)

    assert shown == [True, False]
    screen.peer.close.assert_awaited_once()
    sent = len(channel.sent)
    channel.message(k="s.get")
    assert screen.requests.empty() and len(channel.sent) == sent


async def test_no_further_piece_of_a_frame_leaves_after_the_session_closes() -> None:
    screen, channel = session("192.168.1.6")
    screen.authorized = True
    screen.ready.set()
    send = channel.send

    def send_then_stop(payload: str | bytes) -> None:
        send(payload)
        if isinstance(payload, bytes):
            screen.closed.set()

    channel.send = send_then_stop  # type: ignore[method-assign]
    channel.message(k="s.get")
    frame = Capture(1, 128, 72, b"x" * (3 * CHUNK_BYTES))

    @contextmanager
    def viewing() -> Iterator[None]:
        yield None

    await asyncio.wait_for(screen.stream(lambda _r, _p: frame, lambda: 0, viewing), timeout=2)

    assert sum(isinstance(item, bytes) for item in channel.sent) == 1


@windows_only
@pytest.mark.usefixtures("live_tray")
def test_the_viewing_is_published_only_while_the_indicator_is_up() -> None:
    assert viewing_session() is None
    with screen_indicator() as stop_requested:
        current = viewing_session()
        assert current is not None and len(current) == 32
        assert not stop_requested()
        assert request_screen_stop(current)
        assert stop_requested()
    assert viewing_session() is None
    assert not request_screen_stop(current)


@windows_only
@pytest.mark.usefixtures("live_tray")
def test_an_old_request_does_not_touch_the_next_viewing() -> None:
    with screen_indicator():
        old = viewing_session()
        assert old is not None
        assert request_screen_stop(old)

    with screen_indicator() as stop_requested:
        # O pedido que já tinha chegado à anterior não sobra, e um repetido não acha ninguém.
        assert viewing_session() not in {None, old}
        assert not stop_requested()
        assert not request_screen_stop(old)
        assert not stop_requested()


@windows_only
@pytest.mark.usefixtures("live_tray")
@pytest.mark.parametrize("value", ["", "a" * 31, "A" * 32, "a" * 31 + "\\", "a" * 32 + " x"])
def test_only_a_well_formed_identifier_is_ever_requested(value: str) -> None:
    with screen_indicator() as stop_requested:
        assert not request_screen_stop(value)
        assert not stop_requested()


@windows_only
@pytest.mark.usefixtures("live_tray")
async def test_the_tray_request_stops_the_screen_it_names_and_not_the_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ponta a ponta com os objetos do Windows: o que a bandeja lê é o que ela manda parar."""
    first, _channel, first_task = run_session(monkeypatch, screen_indicator)
    await until(viewing_session)
    old = viewing_session()
    assert old is not None
    assert request_screen_stop(old)
    await asyncio.wait_for(first_task, timeout=2)
    assert first.closed.is_set()
    assert viewing_session() is None  # não volta sozinha

    second, _channel, second_task = run_session(monkeypatch, screen_indicator)
    try:
        await until(viewing_session)
        assert not request_screen_stop(old)
        await asyncio.sleep(0.5)
        assert not second_task.done() and not second.closed.is_set()
        current = viewing_session()
        assert current is not None and current != old
        assert request_screen_stop(current)
        await asyncio.wait_for(second_task, timeout=2)
    finally:
        second_task.cancel()
        await asyncio.gather(second_task, return_exceptions=True)
