"""Ligação do vigia ao agente: só com `adb`, avisado pela sessão e pelo vigia do endereço."""

import asyncio
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_discovery import PortState
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition import tv as tv_module
from uniover_agent.composition.connection import build_relocator
from uniover_agent.config import Settings
from uniover_agent.ports import AdbUnauthorized, TvPortClosed

from .support_adb import ADB, CONNECT, GET_STATE, HOST, SERIAL, FakeAdbRunner, ok, open_gate
from .test_tv_adb_composition import enable_adb
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv


def test_the_watchdog_is_wired_with_the_adb_and_each_piece_has_its_place(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, FakeTvAdb())
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.watchdog is not None
    assert setup.watchdog.run in setup.background
    assert len(setup.after_hello) == 2  # a lista de apps e a entrega dos eventos do vigia


def test_without_the_adb_there_is_nothing_to_restart_with_and_no_watchdog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.watchdog is None
    assert setup.background == []


def test_the_owner_can_turn_the_watchdog_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, FakeTvAdb())
    setup = make_tv(Settings(tv_host=TV_HOST, tv_watchdog=False))
    assert setup is not None
    assert setup.watchdog is None
    monkeypatch.setenv("UNIOVER_TV_WATCHDOG", "false")
    assert Settings().tv_watchdog is False


def probe_answers(monkeypatch: pytest.MonkeyPatch, *answers: PortState) -> list[str]:
    """O `tcp_probe` dos dois vigias dá as respostas em ordem, depois `OPEN`; devolve os alvos."""
    pending = list(answers)
    asked: list[str] = []

    async def probe(host: str, port: int, wait: float = 1.0) -> PortState:
        asked.append(f"{host}:{port}")
        return pending.pop(0) if pending else PortState.OPEN

    monkeypatch.setattr(tv_module, "tcp_probe", probe)
    monkeypatch.setattr(connection_module, "tcp_probe", probe)
    return asked


async def test_a_refusal_seen_by_the_address_watcher_restarts_the_service_through_the_adb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    adb = FakeTvAdb()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    # 1: o vigia do endereço vê a recusa; 2: o vigia do serviço confirma; depois do reparo, de pé.
    asked = probe_answers(monkeypatch, PortState.REFUSED, PortState.REFUSED)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.watchdog is not None
    relocator = build_relocator(
        Settings(tv_host=TV_HOST),
        FakeClock(),
        lambda: False,
        on_refused=setup.watchdog.request,
    )
    assert relocator is not None
    task = asyncio.create_task(setup.watchdog.run())
    assert await relocator.step() is None
    await asyncio.sleep(0.05)
    assert adb.restarts == 1
    assert asked == [f"{TV_HOST}:6466"] * 3 + [f"{TV_HOST}:6467"]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_refused_port_met_by_the_session_also_reaches_the_watchdog(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remote = FakeTvRemote()
    remote.connect_errors = [TvPortClosed("recusou")] * 4
    adb = FakeTvAdb()
    pair_fake_tv(monkeypatch, remote)
    enable_adb(monkeypatch, tmp_path, adb)
    probe_answers(monkeypatch, PortState.REFUSED)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.watchdog is not None
    task = asyncio.create_task(setup.watchdog.run())
    with pytest.raises(Exception, match="religando"):
        await setup.manager.send_key("HOME")
    await asyncio.sleep(0.05)
    assert adb.restarts == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(
    ("state", "warned"),
    [(PortState.REFUSED, 1), (PortState.OPEN, 0), (PortState.SILENT, 0)],
)
async def test_the_address_watcher_only_warns_on_a_refusal_never_on_silence_or_an_answer(
    monkeypatch: pytest.MonkeyPatch, state: PortState, warned: int
) -> None:
    probed: list[str] = []

    async def probe(host: str, port: int, wait: float = 1.0) -> PortState:
        probed.append(host)
        return state

    monkeypatch.setattr(tv_module, "tcp_probe", probe)
    monkeypatch.setattr(connection_module, "tcp_probe", probe)
    calls: list[int] = []
    relocator = build_relocator(
        Settings(tv_host=TV_HOST), FakeClock(), lambda: False, on_refused=lambda: calls.append(1)
    )
    assert relocator is not None
    assert await relocator.step() is None
    assert probed == [TV_HOST]
    assert len(calls) == warned


async def test_a_refusal_never_reopens_the_adb_prompt_while_the_adb_is_unauthorized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = FakeAdbRunner(
        {CONNECT: ok(f"failed to authenticate to {SERIAL}\r\n"), GET_STATE: ok("unauthorized")}
    )
    adb = AdbTv(ADB, HOST, 5555, **open_gate(), timeout=1.0, runner=runner, retry_after=30.0)
    with pytest.raises(AdbUnauthorized):
        await adb.connect()  # a partida do agente: o dono vê o aviso e ainda não o aceitou
    runner.calls.clear()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)  # type: ignore[arg-type]
    probe_answers(monkeypatch, PortState.REFUSED, PortState.REFUSED)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.watchdog is not None
    relocator = build_relocator(
        Settings(tv_host=TV_HOST),
        FakeClock(),
        lambda: False,
        on_refused=setup.watchdog.request,
    )
    assert relocator is not None
    task = asyncio.create_task(setup.watchdog.run())
    assert await relocator.step() is None
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert runner.calls, "o vigia chegou a tentar religar"
    assert CONNECT not in runner.calls
    assert runner.shell_commands() == []
