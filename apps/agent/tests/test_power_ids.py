"""Ids de POWER sobrevivem a reinício e hibernação: hora de parede, em disco, antes de executar."""

import asyncio
import json
import threading
from collections.abc import Mapping
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.power_id_file import POWER_IDS_FILE, PowerIdFile
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ProcessMessage,
    ResultStatus,
)
from uniover_agent.core.power_ids import POWER_ID_CAPACITY, POWER_ID_SECONDS, PowerIds
from uniover_agent.ports import PowerIdStore

from .support import AGENT_ID, dump, tv_key

DAY = 24 * 60 * 60.0
START = 1_800_000_000.0


class Wall:
    """Relógio de parede de teste (o monotônico fica à parte, no `FakeClock`)."""

    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> float:
        return self.now


class Counting:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, command: Command) -> CommandResult:
        self.calls.append(command.id)
        return CommandResult(command.id, ResultStatus.OK)


class MemoryStore:
    def __init__(self, ids: dict[str, float] | None = None) -> None:
        self.ids = dict(ids or {})
        self.saves = 0

    def load(self) -> dict[str, float]:
        return dict(self.ids)

    def save(self, ids: Mapping[str, float]) -> bool:
        self.ids = dict(ids)
        self.saves += 1
        return True


def make_agent(
    handler: Counting, store: PowerIdStore | None, wall: Wall
) -> tuple[ProcessMessage, FakeTransport, FakeClock]:
    """Um agente novo: cada chamada é um processo novo (memória vazia, mesmo disco)."""
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": handler}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        transport,
        monotonic=clock.monotonic,
        power_store=store,
        wall_clock=wall,
    )
    return process, transport, clock


async def feed(process: ProcessMessage, raw: str) -> None:
    await process(raw)
    await process.drain(1.0)


async def test_after_an_agent_restart_the_same_power_id_does_not_run(tmp_path: Path) -> None:
    handler = Counting()
    wall = Wall()
    power = tv_key("POWER")
    first, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(first, dump(power))
    assert handler.calls == [power["id"]]

    # O agente reinicia: processo novo, memória vazia, mesmo disco.
    second, transport, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(second, dump(power))

    assert handler.calls == [power["id"]]  # não executou de novo
    # O repetido recebe `ok` (a API não fica esperando) sem ter tocado a TV.
    assert [m["correlationId"] for m in transport.sent] == [power["id"]]
    assert transport.sent[0]["body"] == {"ok": True}


async def test_a_new_power_id_is_on_disk_before_the_command_runs(tmp_path: Path) -> None:
    seen_on_disk: list[bool] = []
    store = PowerIdFile(tmp_path)

    async def handler(command: Command) -> CommandResult:
        seen_on_disk.append(command.id in store.load())
        return CommandResult(command.id, ResultStatus.OK)

    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    process = ProcessMessage(
        AGENT_ID,
        gate,
        HandleCommand({"tv.key.v1": handler}, clock),
        EnvelopeFactory(AGENT_ID, gate, clock),
        FakeTransport(),
        monotonic=clock.monotonic,
        power_store=store,
        wall_clock=Wall(),
    )

    await feed(process, dump(tv_key("POWER")))

    assert seen_on_disk == [True]


async def test_after_31_days_of_wall_clock_the_id_runs_again(tmp_path: Path) -> None:
    handler = Counting()
    wall = Wall()
    power = tv_key("POWER")
    first, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(first, dump(power))

    wall.now += 29 * DAY
    again, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(again, dump(power))
    assert handler.calls == [power["id"]]  # 29 dias: ainda lembra

    wall.now += 2 * DAY  # 31 dias desde o primeiro
    later, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(later, dump(power))
    assert handler.calls == [power["id"], power["id"]]


async def test_the_wall_clock_expires_the_id_inside_a_running_agent_too() -> None:
    # Hibernação: o monotônico não decide nada, a hora de parede é quem manda.
    handler = Counting()
    wall = Wall()
    process, _, clock = make_agent(handler, None, wall)
    power = tv_key("POWER")
    await feed(process, dump(power))

    clock.advance(40 * DAY)  # o relógio monotônico andar não expira nada
    await feed(process, dump(power))
    assert handler.calls == [power["id"]]

    wall.now += POWER_ID_SECONDS + 1
    await feed(process, dump(power))
    assert len(handler.calls) == 2


@pytest.mark.parametrize(
    "content",
    [
        b"{not json",
        b"\xff\xfe\x00garbage",
        b'["lista"]',
        b'{"ids": ["a"]}',
        b'{"outro": 1}',
        b"",
    ],
)
async def test_a_corrupted_file_is_treated_as_empty_and_the_button_still_works(
    tmp_path: Path, content: bytes, caplog: pytest.LogCaptureFixture
) -> None:
    (tmp_path / POWER_IDS_FILE).write_bytes(content)
    handler = Counting()
    wall = Wall()
    power = tv_key("POWER")

    process, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    await feed(process, dump(power))

    assert handler.calls == [power["id"]]
    assert any("POWER" in record.message for record in caplog.records)
    # E o arquivo volta a ser válido: o id novo já está gravado.
    assert power["id"] in PowerIdFile(tmp_path).load()


def test_entries_with_bad_values_are_dropped_and_good_ones_kept(tmp_path: Path) -> None:
    good = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f"
    payload = {"ids": {good: START, "x": "texto", "y": None, "z": True}}
    (tmp_path / POWER_IDS_FILE).write_text(json.dumps(payload), encoding="utf-8")

    assert PowerIdFile(tmp_path).load() == {good: START}


async def test_the_cap_is_1000_ids_and_the_oldest_leave_first() -> None:
    wall = Wall()
    store = MemoryStore()
    ids = PowerIds(store, wall)
    for number in range(POWER_ID_CAPACITY + 5):
        wall.now += 1
        assert ids.admit(f"id-{number}")
    await ids.persist()

    kept = set(store.ids)
    assert len(kept) == POWER_ID_CAPACITY
    assert "id-0" not in kept
    assert "id-4" not in kept
    assert "id-5" in kept
    assert f"id-{POWER_ID_CAPACITY + 4}" in kept


def test_a_loaded_list_over_the_cap_keeps_the_newest() -> None:
    stored = {f"id-{n}": START + n for n in range(POWER_ID_CAPACITY + 50)}
    ids = PowerIds(MemoryStore(stored), lambda: START + POWER_ID_CAPACITY + 50)

    assert not ids.admit(f"id-{POWER_ID_CAPACITY + 49}")  # o mais novo segue lembrado
    assert ids.admit("id-0")  # o mais antigo saiu


async def test_a_repeated_power_id_is_not_written_again() -> None:
    store = MemoryStore()
    ids = PowerIds(store, Wall())
    assert ids.admit("a")
    assert not ids.admit("a")
    await ids.persist()
    await ids.persist()
    assert store.saves == 1


def test_a_failed_save_never_raises_and_is_logged_as_an_error(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "ocupado"
    blocker.write_text("é um arquivo, não uma pasta", encoding="utf-8")

    assert PowerIdFile(blocker).save({"a": START}) is False  # `mkdir` falha

    errors = [r for r in caplog.records if r.levelname == "ERROR" and "POWER" in r.message]
    assert errors
    assert errors[0].exc_info is not None  # a causa vai junto


class FailingStore(MemoryStore):
    def save(self, ids: Mapping[str, float]) -> bool:
        self.saves += 1
        return False


async def test_when_the_disk_fails_the_power_still_runs_and_the_next_one_tries_again() -> None:
    handler = Counting()
    store = FailingStore()
    process, _, _ = make_agent(handler, store, Wall())
    first, second = tv_key("POWER"), tv_key("POWER")

    await feed(process, dump(first))
    await feed(process, dump(second))

    assert handler.calls == [first["id"], second["id"]]  # o botão nunca trava por disco
    assert store.saves == 2  # a falha deixou a lista suja: o segundo POWER tentou de novo
    await feed(process, dump(first))
    assert handler.calls == [first["id"], second["id"]]  # e o id segue lembrado na memória


class SlowStore(MemoryStore):
    """Uma gravação que demora até o teste soltar (disco lento)."""

    def __init__(self) -> None:
        super().__init__()
        self.release = threading.Event()
        self.started = threading.Event()

    def save(self, ids: Mapping[str, float]) -> bool:
        self.started.set()
        self.release.wait(5)
        return super().save(ids)


async def test_a_slow_disk_never_holds_the_reader_and_a_repeat_is_still_recognised() -> None:
    handler = Counting()
    store = SlowStore()
    process, transport, _ = make_agent(handler, store, Wall())
    power = tv_key("POWER")

    # O leitor devolve na hora, com a gravação ainda parada no disco.
    await asyncio.wait_for(process(dump(power)), timeout=1)
    await asyncio.to_thread(store.started.wait, 2)
    assert handler.calls == []  # a tecla só vai depois de o id estar em disco
    # Um repetido que chega agora já é reconhecido (a memória é imediata) e nada executa.
    await asyncio.wait_for(process(dump(power)), timeout=1)
    assert handler.calls == []

    store.release.set()
    await process.drain(2.0)
    assert handler.calls == [power["id"]]
    assert power["id"] in store.ids
    assert [m["correlationId"] for m in transport.sent] == [power["id"]]


async def test_at_a_handover_the_new_process_learns_the_ids_the_old_one_wrote_later(
    tmp_path: Path,
) -> None:
    handler = Counting()
    wall = Wall()
    old, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    # O processo novo nasce e lê o arquivo (ainda vazio)...
    new, new_transport, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    # ...e só depois a antiga, que ainda é a dona, aceita e grava um POWER.
    power = tv_key("POWER")
    await feed(old, dump(power))
    assert handler.calls == [power["id"]]

    # Ao assumir a trava, a nova junta o arquivo antes de virar dona.
    await new.refresh_power_ids()
    await feed(new, dump(power))

    assert handler.calls == [power["id"]]  # o reenvio não executa de novo
    assert [m["correlationId"] for m in new_transport.sent] == [power["id"]]


async def test_the_merge_keeps_what_the_new_process_already_knew(tmp_path: Path) -> None:
    handler = Counting()
    wall = Wall()
    new, _, _ = make_agent(handler, PowerIdFile(tmp_path), wall)
    mine = tv_key("POWER")
    await feed(new, dump(mine))
    theirs = {"0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f": START + 5}
    (tmp_path / POWER_IDS_FILE).write_text(json.dumps({"ids": theirs}), encoding="utf-8")

    await new.refresh_power_ids()
    await feed(new, dump(mine))
    await feed(new, dump(tv_key("POWER")))  # um id novo grava a união

    saved = PowerIdFile(tmp_path).load()
    assert mine["id"] in saved
    assert next(iter(theirs)) in saved
    assert handler.calls.count(mine["id"]) == 1
