"""Aprovação de aparelho novo no PC: pergunta ao dono uma vez, guarda, recusa com código claro."""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.pc_approval_prompt import WindowsApprovalPrompt, question
from uniover_agent.adapters.pc_device_store import JsonDeviceStore
from uniover_agent.core import (
    Command,
    CommandResult,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    ResultStatus,
)
from uniover_agent.core.pc.devices import (
    DEVICE_DENIED,
    DEVICE_PENDING,
    DeviceApprovals,
    DeviceDecision,
    clean_name,
    device_key,
)
from uniover_agent.core.pc.lane import PcLane
from uniover_agent.ports.pc_devices import DeviceRecord

from .support import AGENT_ID

DEVICE = "3fa9c10d7be2465a3fa9c10d7be2465a"


class Memory:
    """Um arquivo de mentira."""

    def __init__(self, records: dict[str, DeviceRecord] | None = None) -> None:
        self.records = dict(records or {})
        self.saves = 0
        self.seen = False

    def api_seen(self) -> bool:
        return self.seen

    def mark_api_seen(self) -> None:
        self.seen = True

    def load(self) -> dict[str, DeviceRecord]:
        return dict(self.records)

    def save(self, records: dict[str, DeviceRecord]) -> None:
        self.records = dict(records)
        self.saves += 1


class Prompt:
    """O dono de mentira: cada pergunta espera `answer` (ou o teste responde quando quiser)."""

    def __init__(self) -> None:
        self.asked: list[str] = []
        self.gate = asyncio.Event()
        self.answers: list[bool | None] = []
        self.active = 0
        self.peak = 0
        self.closed = False

    async def ask(self, name: str) -> bool | None:
        self.asked.append(name)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await self.gate.wait()
            return self.answers.pop(0) if self.answers else True
        finally:
            self.active -= 1

    async def aclose(self) -> None:
        self.closed = True


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


class Clockwork:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


ANNOUNCED: list[tuple[str, str]] = []


def make(
    prompt: Prompt | None = None,
    memory: Memory | None = None,
    *,
    answered: bool = True,
    supports: bool = True,
) -> tuple[DeviceApprovals, Prompt, Memory, Clockwork]:
    prompt = prompt or Prompt()
    memory = memory or Memory()
    clock = Clockwork()
    approvals = DeviceApprovals(memory, prompt, now=clock)
    ANNOUNCED.clear()
    approvals.bind_api(
        answered=lambda: answered,
        supports=lambda: supports,
        announce=lambda device, state: ANNOUNCED.append((device, state)),
    )
    return approvals, prompt, memory, clock


# ---- decisões ----------------------------------------------------------------------------------


async def test_the_first_time_asks_the_owner_and_stays_pending_until_answered() -> None:
    approvals, prompt, _, _ = make()

    assert approvals.check(DEVICE, "iPhone (Safari)") is DeviceDecision.PENDING
    assert approvals.check(DEVICE, "iPhone (Safari)") is DeviceDecision.PENDING
    await settle()

    assert prompt.asked == ["iPhone (Safari)"]  # uma pergunta só, por mais comandos que cheguem
    assert approvals.check(DEVICE, "iPhone (Safari)") is DeviceDecision.PENDING


async def test_allowing_remembers_the_device_and_never_asks_again() -> None:
    approvals, prompt, memory, _ = make()
    approvals.check(DEVICE, "iPhone (Safari)")
    prompt.answers = [True]
    prompt.gate.set()
    await settle()

    assert approvals.check(DEVICE, "iPhone (Safari)") is DeviceDecision.APPROVED
    assert approvals.check(DEVICE, "outro nome qualquer") is DeviceDecision.APPROVED
    assert len(prompt.asked) == 1
    # No arquivo vai só o resumo do identificador, nunca o identificador.
    saved = next(iter(memory.records))
    assert saved == device_key(DEVICE) and DEVICE not in saved
    assert memory.records[saved].state == "approved"


async def test_a_new_agent_process_still_knows_the_approved_device() -> None:
    approvals, prompt, memory, _ = make()
    approvals.check(DEVICE, "iPhone")
    prompt.gate.set()
    await settle()

    again = DeviceApprovals(memory, Prompt())
    assert again.check(DEVICE, "iPhone") is DeviceDecision.APPROVED


async def test_refusing_denies_for_an_hour_and_then_asks_again() -> None:
    approvals, prompt, _, clock = make()
    approvals.check(DEVICE, "Android (Chrome)")
    prompt.answers = [False]
    prompt.gate.set()
    await settle()

    assert approvals.check(DEVICE, "Android (Chrome)") is DeviceDecision.DENIED
    clock.now += 3_599
    assert approvals.check(DEVICE, "Android (Chrome)") is DeviceDecision.DENIED
    assert len(prompt.asked) == 1

    clock.now += 2  # a recusa venceu
    assert approvals.check(DEVICE, "Android (Chrome)") is DeviceDecision.PENDING
    await settle()
    assert len(prompt.asked) == 2


async def test_a_question_that_could_not_be_asked_is_retried_later_not_in_a_loop() -> None:
    approvals, prompt, _, clock = make()
    prompt.answers = [None, True]
    prompt.gate.set()

    assert approvals.check(DEVICE, "iPad") is DeviceDecision.PENDING
    await settle()
    assert approvals.check(DEVICE, "iPad") is DeviceDecision.PENDING  # ainda dentro da espera
    await settle()
    assert len(prompt.asked) == 1

    clock.now += 31
    assert approvals.check(DEVICE, "iPad") is DeviceDecision.PENDING
    await settle()
    assert len(prompt.asked) == 2
    assert approvals.check(DEVICE, "iPad") is DeviceDecision.APPROVED


async def test_only_one_window_is_open_at_a_time() -> None:
    approvals, prompt, _, _ = make()
    approvals.check("aaaaaaaaaaaaaaaa", "A")
    approvals.check("bbbbbbbbbbbbbbbb", "B")
    await settle()

    assert prompt.asked == ["A"] and prompt.peak == 1
    prompt.gate.set()
    await settle()
    assert prompt.asked == ["A", "B"] and prompt.peak == 1


async def test_a_failing_prompt_leaves_the_device_pending_without_crashing() -> None:
    class Broken:
        async def ask(self, name: str) -> bool | None:
            raise RuntimeError("sem janela")

        async def aclose(self) -> None: ...

    approvals = DeviceApprovals(Memory(), Broken())
    assert approvals.check(DEVICE, "iPhone") is DeviceDecision.PENDING
    await settle()
    assert approvals.check(DEVICE, "iPhone") is DeviceDecision.PENDING


async def test_a_store_that_cannot_load_or_save_does_not_break_the_decision() -> None:
    class Bad:
        def load(self) -> dict[str, DeviceRecord]:
            raise OSError("disco")

        def save(self, records: dict[str, DeviceRecord]) -> None:
            raise OSError("disco")

        def api_seen(self) -> bool:
            raise OSError("disco")

        def mark_api_seen(self) -> None:
            raise OSError("disco")

    prompt = Prompt()
    approvals = DeviceApprovals(Bad(), prompt)
    approvals.check(DEVICE, "iPhone")
    prompt.gate.set()
    await settle()

    assert approvals.check(DEVICE, "iPhone") is DeviceDecision.APPROVED  # vale ao menos na memória


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("iPhone (Safari)", "iPhone (Safari)"),
        ("  iPhone \n\t (Safari) ", "iPhone (Safari)"),
        ("Pwn" + chr(0x202E) + "ed" + chr(0) + chr(0x200B), "Pwned"),  # bidi, nulo, largura zero
        ("", "um aparelho"),
        (None, "um aparelho"),
        ("x" * 200, "x" * 60),
    ],
)
def test_the_name_the_owner_sees_is_cleaned(raw: str | None, expected: str) -> None:
    assert clean_name(raw) == expected


# ---- o arquivo e a janela ----------------------------------------------------------------------


def test_the_store_round_trips_and_survives_a_broken_file(tmp_path: Path) -> None:
    path = tmp_path / "runtime" / "pc-devices.json"
    store = JsonDeviceStore(path)
    assert store.load() == {}

    store.save({"abc": DeviceRecord("approved", "iPhone", 12.5)})
    assert store.load() == {"abc": DeviceRecord("approved", "iPhone", 12.5)}
    assert DEVICE not in path.read_text(encoding="utf-8")

    path.write_text("{ isso não é json", encoding="utf-8")
    assert store.load() == {}
    path.write_text(json.dumps({"devices": {"x": {"state": "talvez"}, "y": 3}}), encoding="utf-8")
    assert store.load() == {}  # entrada fora do formato é ignorada


async def test_the_open_window_is_closed_when_the_agent_stops_and_never_blocks_the_exit() -> None:
    import threading  # noqa: PLC0415

    release = threading.Event()
    shown: list[str] = []
    closed: list[str] = []

    def blocking_box(text: str, title: str, flags: int) -> int:
        shown.append(title)
        release.wait(10)  # o MessageBoxW de verdade: bloqueia até alguém clicar
        return 7  # o "Não" que o fechamento clica

    def close_window(title: str) -> bool:
        if title not in shown:
            return False  # a thread ainda não abriu a janela: tenta de novo
        closed.append(title)
        release.set()
        return True

    prompt = WindowsApprovalPrompt(blocking_box, close_window)
    asking = asyncio.ensure_future(prompt.ask("iPhone"))
    await asyncio.sleep(0.05)
    assert shown and not asking.done()
    thread = next(t for t in threading.enumerate() if t.name == "uniover-approval")
    assert thread.daemon  # nunca segura o encerramento do processo

    await asyncio.wait_for(prompt.aclose(), 5)

    assert closed == shown
    assert (
        await asyncio.wait_for(asking, 2) is None
    )  # fechada pelo agente: sem resposta, sem decisão
    assert not thread.is_alive()


async def test_cancelling_the_question_closes_its_window_too() -> None:
    import threading  # noqa: PLC0415

    release = threading.Event()
    shown: list[str] = []

    def blocking_box(text: str, title: str, flags: int) -> int:
        shown.append(title)
        release.wait(10)
        return 7

    def close_window(title: str) -> bool:
        if title not in shown:
            return False
        release.set()
        return True

    prompt = WindowsApprovalPrompt(blocking_box, close_window)
    asking = asyncio.ensure_future(prompt.ask("iPhone"))
    await asyncio.sleep(0.05)
    asking.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asking

    assert release.is_set()


async def test_a_window_that_cannot_be_found_does_not_hold_the_exit_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading  # noqa: PLC0415

    from uniover_agent.adapters import pc_approval_prompt  # noqa: PLC0415

    monkeypatch.setattr(pc_approval_prompt, "CLOSE_WAIT_SECONDS", 0.2)
    release = threading.Event()
    prompt = WindowsApprovalPrompt(lambda t, ti, f: release.wait(10) and 7, lambda title: False)
    asking = asyncio.ensure_future(prompt.ask("iPhone"))
    await asyncio.sleep(0.05)
    try:
        await asyncio.wait_for(prompt.aclose(), 3)  # desiste depois do prazo; a thread é daemon
    finally:
        release.set()
        await asyncio.wait_for(asking, 2)


async def test_cancelling_the_question_does_not_block_the_loop_and_close_waits_for_the_closer() -> (
    None
):
    import threading  # noqa: PLC0415
    import time  # noqa: PLC0415

    release = threading.Event()
    shown: list[str] = []
    attempts: list[str] = []

    def blocking_box(text: str, title: str, flags: int) -> int:
        shown.append(title)
        release.wait(10)
        return 7

    def slow_close(title: str) -> bool:
        attempts.append(title)
        time.sleep(0.3)  # o Windows demorando a achar a janela
        release.set()
        return True

    prompt = WindowsApprovalPrompt(blocking_box, slow_close)
    asking = asyncio.ensure_future(prompt.ask("iPhone"))
    await asyncio.sleep(0.05)
    began = time.monotonic()
    asking.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asking
    assert time.monotonic() - began < 0.15  # o laço de quem cancelou não esperou o fechamento

    await asyncio.wait_for(prompt.aclose(), 5)  # quem encerra espera o fechamento terminar
    assert attempts and release.is_set()


async def test_a_question_nobody_answers_closes_as_no_answer_and_frees_the_turn() -> None:
    import threading  # noqa: PLC0415

    release = threading.Event()
    shown: list[str] = []

    def blocking_box(text: str, title: str, flags: int) -> int:
        shown.append(title)
        release.wait(10)
        return 7  # o "Não" que o fechamento clica

    def close_window(title: str) -> bool:
        if title not in shown:
            return False
        release.set()
        return True

    prompt = WindowsApprovalPrompt(blocking_box, close_window, ask_timeout_seconds=0.15)

    answer = await asyncio.wait_for(prompt.ask("iPhone"), 5)

    assert answer is None  # sem resposta: nunca vira recusa nem permissão
    assert release.is_set()
    await prompt.aclose()


async def test_the_window_asks_with_no_as_the_default_and_maps_the_answer() -> None:
    shown: list[tuple[str, str, int]] = []

    def box(answer: int) -> Any:
        def show(text: str, title: str, flags: int) -> int:
            shown.append((text, title, flags))
            return answer

        return show

    assert await WindowsApprovalPrompt(box(6)).ask("iPhone (Safari)") is True
    assert await WindowsApprovalPrompt(box(7)).ask("iPhone (Safari)") is False
    assert await WindowsApprovalPrompt(box(0)).ask("iPhone (Safari)") is None

    text, title, flags = shown[0]
    assert text == question("iPhone (Safari)")
    assert "Permitir que iPhone (Safari) controle este PC?" in text
    assert title.startswith("UniOver (")  # título único: o encerramento acha a janela por ele
    assert flags & 0x4 and flags & 0x100 and flags & 0x40000  # Sim/Não, "Não" padrão, por cima


# ---- a faixa: quem ainda não foi aprovado não executa nada --------------------------------------


class Probe:
    def __init__(self) -> None:
        self.log: list[str] = []

    async def click(self, command: Command) -> CommandResult:
        self.log.append(f"click:{command.body['action']}")
        return CommandResult(command.id, ResultStatus.OK)

    async def pointer(self, command: Command) -> CommandResult:
        self.log.append("move")
        return CommandResult(command.id, ResultStatus.OK)


def lane_with(
    approvals: DeviceApprovals, probe: Probe, closed: list[str]
) -> tuple[PcLane, FakeTransport]:
    clock = FakeClock()
    transport = FakeTransport()
    lane = PcLane(
        HandleCommand({"pc.click.v1": probe.click, "pc.pointer.v1": probe.pointer}, clock),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        transport,
        silent_types={"pc.pointer.v1"},
        on_cloud_pc_input=lambda *a: closed.append("direct-closed"),
        devices=approvals,
    )
    return lane, transport


def click(command_id: str, device: str | None = DEVICE) -> Command:
    return Command(
        command_id,
        "pc.click.v1",
        {"button": "LEFT", "action": "CLICK"},
        device_id=device,
        device_name="iPhone (Safari)" if device else None,
    )


def results(transport: FakeTransport) -> dict[str, str]:
    return {
        m["correlationId"]: (m["body"].get("error") or {}).get("code", "") for m in transport.sent
    }


async def test_an_unknown_device_gets_pending_and_nothing_runs_or_closes_the_direct_channel() -> (
    None
):
    approvals, _prompt, _, _ = make()
    probe, closed = Probe(), list[str]()
    lane, transport = lane_with(approvals, probe, closed)
    try:
        lane.accept(click("11111111-1111-4111-8111-111111111111"))
        lane.accept(Command("m1", "pc.pointer.v1", {"dx": 5, "dy": 5}, device_id=DEVICE))
        await settle()

        assert probe.log == [] and closed == []  # nada executou, e o canal direto de outro segue
        assert results(transport) == {"11111111-1111-4111-8111-111111111111": DEVICE_PENDING}
    finally:
        await lane.aclose()
        await approvals.aclose()


async def test_after_the_owner_allows_the_same_device_runs_normally() -> None:
    approvals, prompt, _, _ = make()
    probe, closed = Probe(), list[str]()
    lane, transport = lane_with(approvals, probe, closed)
    try:
        lane.accept(click("11111111-1111-4111-8111-111111111111"))
        prompt.gate.set()
        await settle()
        lane.accept(click("22222222-2222-4222-8222-222222222222"))
        lane.accept(Command("m2", "pc.pointer.v1", {"dx": 5, "dy": 5}, device_id=DEVICE))
        await settle()

        assert probe.log == ["click:CLICK", "move"]
        assert closed == ["direct-closed"] * 2
        assert results(transport)["22222222-2222-4222-8222-222222222222"] == ""
    finally:
        await lane.aclose()
        await approvals.aclose()


async def test_a_refused_device_gets_a_clear_denied_result() -> None:
    approvals, prompt, _, _ = make()
    probe, closed = Probe(), list[str]()
    lane, transport = lane_with(approvals, probe, closed)
    try:
        lane.accept(click("11111111-1111-4111-8111-111111111111"))
        prompt.answers = [False]
        prompt.gate.set()
        await settle()
        lane.accept(click("22222222-2222-4222-8222-222222222222"))
        await settle()

        assert results(transport)["22222222-2222-4222-8222-222222222222"] == DEVICE_DENIED
        assert probe.log == []
    finally:
        await lane.aclose()
        await approvals.aclose()


async def test_a_command_without_a_device_passes_only_with_an_api_that_has_no_approval() -> None:
    # API anterior à aprovação (ela RESPONDEU e não lista `pc.device.v1`): decisão explícita, nada é
    # perguntado nem recusado.
    approvals, prompt, _, _ = make(answered=True, supports=False)
    probe, closed = Probe(), list[str]()
    lane, _ = lane_with(approvals, probe, closed)
    try:
        lane.accept(click("11111111-1111-4111-8111-111111111111", device=None))
        await settle()

        assert probe.log == ["click:CLICK"] and prompt.asked == []
    finally:
        await lane.aclose()
        await approvals.aclose()


@pytest.mark.parametrize(
    ("answered", "supports"),
    [
        (False, False),  # partida: a API ainda não disse o que aceita
        (
            True,
            True,
        ),  # a API oferece a aprovação, mas este comando veio sem aparelho (hello em curso)
    ],
)
async def test_a_command_without_a_device_fails_closed_while_the_api_is_unknown(
    answered: bool, supports: bool
) -> None:
    approvals, prompt, _, _ = make(answered=answered, supports=supports)
    probe, closed = Probe(), list[str]()
    lane, transport = lane_with(approvals, probe, closed)
    try:
        lane.accept(click("11111111-1111-4111-8111-111111111111", device=None))
        lane.accept(Command("m1", "pc.pointer.v1", {"dx": 5, "dy": 5}))
        await settle()

        assert probe.log == [] and closed == [] and prompt.asked == []
        assert results(transport) == {"11111111-1111-4111-8111-111111111111": "device_unknown"}
    finally:
        await lane.aclose()
        await approvals.aclose()


async def test_once_the_api_has_listed_the_approval_it_never_goes_back_to_no_approval() -> None:
    # Instância antiga de uma API que já oferecia a aprovação (deploy sem downtime): "não lista"
    # depois de "lista" é suspeito, nunca o modo sem aprovação.
    state = {"answered": True, "supports": True}
    memory = Memory()
    approvals = DeviceApprovals(memory, Prompt(), now=Clockwork())
    approvals.bind_api(
        answered=lambda: state["answered"],
        supports=lambda: state["supports"],
        announce=lambda device, name: None,
    )

    assert (
        approvals.check(None, None) is DeviceDecision.UNKNOWN
    )  # lista, mas o comando veio sem aparelho
    assert memory.seen  # gravado: sobrevive a um reinício

    state["supports"] = False  # a resposta seguinte da API não a lista
    assert approvals.check(None, None) is DeviceDecision.UNKNOWN
    assert not approvals.api_without_approval()

    # E depois de reiniciar o agente (o disco lembra), mesmo com a API só dizendo "não lista".
    reborn = DeviceApprovals(memory, Prompt(), now=Clockwork())
    reborn.bind_api(answered=lambda: True, supports=lambda: False, announce=lambda d, n: None)
    assert reborn.check(None, None) is DeviceDecision.UNKNOWN


async def test_note_api_records_the_listing_even_before_any_command_arrives() -> None:
    memory = Memory()
    approvals = DeviceApprovals(memory, Prompt(), now=Clockwork())
    listed = {"value": False}
    approvals.bind_api(
        answered=lambda: True, supports=lambda: listed["value"], announce=lambda d, n: None
    )
    approvals.note_api()
    assert not memory.seen
    listed["value"] = True
    approvals.note_api()  # a consulta de features mudou: o agente grava na hora
    assert memory.seen


def test_the_store_remembers_that_the_api_listed_the_approval(tmp_path: Path) -> None:
    path = tmp_path / "runtime" / "pc-devices.json"
    store = JsonDeviceStore(path)
    store.save({"abc": DeviceRecord("approved", "iPhone", 1.0)})
    assert not store.api_seen()

    store.mark_api_seen()

    again = JsonDeviceStore(path)
    assert again.api_seen()
    assert again.load() == {"abc": DeviceRecord("approved", "iPhone", 1.0)}  # as decisões ficam
    again.save({})  # salvar decisões não apaga o que já se viu
    assert JsonDeviceStore(path).api_seen()


async def test_the_api_feature_check_tells_not_listed_from_not_known_yet() -> None:
    from uniover_agent.core.api_features import ApiFeatures  # noqa: PLC0415

    answers: list[frozenset[str] | None] = [None, frozenset(), frozenset({"pc.device.v1"})]

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())
    assert not features.answered
    await features.refresh()  # a consulta falhou: continua sem saber
    assert not features.answered
    await features.refresh()  # uma API anterior responde com a lista vazia: é uma resposta
    assert features.answered and not features.supports("pc.device.v1")
    await features.refresh()
    assert features.answered and features.supports("pc.device.v1")


async def test_the_api_is_told_when_the_owner_decides_and_while_the_device_keeps_insisting() -> (
    None
):
    approvals, prompt, _, clock = make()
    probe, closed = Probe(), list[str]()
    lane, _ = lane_with(approvals, probe, closed)
    try:
        for step in range(200):  # o toque no touchpad: 200 movimentos descartados em ~3 s
            lane.accept(Command(f"m{step}", "pc.pointer.v1", {"dx": 1, "dy": 1}, device_id=DEVICE))
            clock.now += 0.016
        await settle()
        # Um aviso por 10 s (e o primeiro, ao abrir a pergunta), nunca um por movimento.
        assert ANNOUNCED == [(DEVICE, "pending")]
        clock.now += 10
        lane.accept(Command("m-late", "pc.pointer.v1", {"dx": 1, "dy": 1}, device_id=DEVICE))
        assert ANNOUNCED == [(DEVICE, "pending"), (DEVICE, "pending")]

        prompt.answers = [True]
        prompt.gate.set()
        await settle()
        assert ANNOUNCED[-1] == (DEVICE, "approved")  # a API limpa o aviso
    finally:
        await lane.aclose()
        await approvals.aclose()


async def test_a_refusal_is_announced_and_renewed_but_an_old_api_hears_nothing() -> None:
    approvals, prompt, _, clock = make()
    approvals.check(DEVICE, "Android")
    prompt.answers = [False]
    prompt.gate.set()
    await settle()
    assert ANNOUNCED[-1] == (DEVICE, "denied")
    count = len(ANNOUNCED)
    approvals.check(DEVICE, "Android")  # logo depois: já foi dito
    assert len(ANNOUNCED) == count
    clock.now += 11
    approvals.check(DEVICE, "Android")
    assert ANNOUNCED[-1] == (DEVICE, "denied") and len(ANNOUNCED) == count + 1

    legacy, _, _, _ = make(supports=False)
    legacy.check(DEVICE, "Android")
    assert ANNOUNCED == []  # uma API anterior recusaria o tipo de mensagem


async def test_closing_the_agent_closes_the_window_and_the_prompt_without_deciding() -> None:
    approvals, prompt, memory, _ = make()
    approvals.check(DEVICE, "iPhone")
    await settle()
    assert prompt.asked == ["iPhone"]

    await approvals.aclose()

    assert prompt.closed
    assert memory.records == {}  # nada vira decisão por o agente ter fechado


async def test_the_operation_goes_to_the_log_with_type_path_and_times_but_never_the_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    probe, closed = Probe(), list[str]()
    approvals, _, _, _ = make(supports=False)
    lane, _ = lane_with(approvals, probe, closed)
    try:
        command = Command(
            "11111111-1111-4111-8111-111111111111",
            "pc.click.v1",
            {"button": "LEFT", "action": "CLICK"},
            operation_id="0192f1e47b3a7c2e",
        )
        lane.accept(command)
        lane.accept(Command("m3", "pc.pointer.v1", {"dx": 123, "dy": 456}))
        await settle()

        lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("operação")]
        assert len(lines) == 1  # o movimento do mouse não entra
        assert "0192f1e47b3a7c2e" in lines[0] and "pc.click.v1" in lines[0]
        assert "via nuvem" in lines[0] and "fila" in lines[0] and "execução" in lines[0]
        assert "resultado ok" in lines[0]
        assert "LEFT" not in caplog.text and "123" not in caplog.text and "456" not in caplog.text
    finally:
        await lane.aclose()
        await approvals.aclose()


# ---- o envelope e a montagem ---------------------------------------------------------------------


def test_the_gate_hands_the_operation_and_the_device_of_the_envelope_to_the_command() -> None:
    from .support import dump, envelope  # noqa: PLC0415

    gate = EnvelopeGate(AGENT_ID)
    raw = dump(
        envelope(
            "pc.click.v2",
            {"button": "LEFT", "action": "CLICK"},
            operationId="0192f1e47b3a7c2e",
            deviceId=DEVICE,
            deviceName="iPhone (Safari)",
        )
    )

    outcome = gate.check_inbound(raw)

    command = outcome.command  # type: ignore[union-attr]
    assert command.operation_id == "0192f1e47b3a7c2e"
    assert (command.device_id, command.device_name) == (DEVICE, "iPhone (Safari)")
    plain = gate.check_inbound(dump(envelope("pc.click.v2", {"button": "LEFT"})))
    assert plain.command.operation_id is None and plain.command.device_id is None  # type: ignore[union-attr]


@pytest.mark.parametrize("extra", [{"operationId": "abc"}, {"deviceId": "com espaço"}])
def test_the_gate_still_refuses_a_malformed_operation_or_device(extra: dict[str, str]) -> None:
    from .support import dump, envelope  # noqa: PLC0415

    outcome = EnvelopeGate(AGENT_ID).check_inbound(
        dump(envelope("pc.click.v2", {"button": "LEFT"}, **extra))
    )

    assert outcome.reason == "fora_do_contrato"  # type: ignore[union-attr]


def test_the_agent_declares_the_new_capabilities_only_as_it_can_honor_them() -> None:
    from uniover_agent.composition.pc import build_pc  # noqa: PLC0415
    from uniover_agent.config import Settings  # noqa: PLC0415

    from .support import FakeAudio  # noqa: PLC0415
    from .test_pc_composition import FakeInput, FakeLauncher, FakePower  # noqa: PLC0415

    def build(devices: DeviceApprovals | None) -> list[str]:
        gate = EnvelopeGate(AGENT_ID)
        pc = build_pc(
            Settings(pc_control=True, pc_direct=False),
            FakeTransport(),
            EnvelopeFactory(AGENT_ID, gate, FakeClock()),
            platform="win32",
            pc_input=FakeInput(),
            power=FakePower(),
            launcher=FakeLauncher(),
            audio=FakeAudio(),
            gate=gate,
            agent_id=AGENT_ID,
            devices=devices,
        )
        assert pc is not None
        return pc.capabilities

    without = build(None)
    with_approvals = build(DeviceApprovals(Memory(), Prompt()))

    assert "pc.op.v1" in without and "pc.device.v1" not in without
    assert "pc.op.v1" in with_approvals and "pc.device.v1" in with_approvals


@pytest.mark.parametrize("isolate", [False, True])
async def test_the_device_state_reaches_the_api_through_either_loop_layout(isolate: bool) -> None:
    import threading  # noqa: PLC0415

    from uniover_agent.composition.pc import build_pc  # noqa: PLC0415
    from uniover_agent.config import Settings  # noqa: PLC0415

    from .support import FakeAudio  # noqa: PLC0415
    from .test_pc_composition import FakeInput, FakeLauncher, FakePower  # noqa: PLC0415

    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    prompt = Prompt()
    approvals = DeviceApprovals(Memory(), prompt)
    pc = build_pc(
        Settings(pc_control=True, pc_direct=False),
        transport,
        EnvelopeFactory(AGENT_ID, gate, FakeClock()),
        platform="win32",
        pc_input=FakeInput(),
        power=FakePower(),
        launcher=FakeLauncher(),
        audio=FakeAudio(),
        gate=gate,
        agent_id=AGENT_ID,
        devices=approvals,
        isolate_input=isolate,
    )
    assert pc is not None
    pc.bind_device_api(answered=lambda: True, supports=lambda: True)
    pc.start()
    try:
        done = threading.Event()

        def ask() -> None:
            approvals.check(DEVICE, "iPhone")
            done.set()

        pc.on_lane(ask)
        for _ in range(100):
            if transport.sent:
                break
            await asyncio.sleep(0.02)

        assert [m["type"] for m in transport.sent] == ["pc.device.state.v1"]
        assert transport.sent[0]["body"]["deviceId"] == DEVICE
        assert transport.sent[0]["body"]["state"] == "pending"
    finally:
        await pc.close_direct()
        await pc.stop_input()


async def test_an_approved_device_does_not_wait_for_the_slow_features_cycle() -> None:
    # Rollout: a API listava `pc.device.v1`, uma instância antiga responde sem ela, e a seguinte
    # volta a listar. O agente pede nova consulta (no máximo a cada 15 s) e o hello volta.
    from uniover_agent.core.api_features import ApiFeatures  # noqa: PLC0415

    answers: list[frozenset[str] | None] = [
        frozenset({"pc.device.v1"}),
        frozenset(),
        frozenset({"pc.device.v1"}),
        frozenset(),
        frozenset({"pc.device.v1"}),
    ]
    hellos: list[int] = []

    async def fetch() -> frozenset[str] | None:
        return answers.pop(0)

    features = ApiFeatures(fetch, FakeClock())

    async def hello_now() -> None:
        hellos.append(1)

    features.on_added = hello_now
    clock = Clockwork()
    approvals = DeviceApprovals(Memory(), Prompt(), now=clock)
    tasks: list[asyncio.Future[None]] = []

    def ask_again() -> None:
        tasks.append(asyncio.ensure_future(features.refresh()))

    approvals.bind_api(
        answered=lambda: features.answered,
        supports=lambda: features.supports("pc.device.v1"),
        announce=lambda device, state: None,
        refresh=ask_again,
    )

    await features.refresh()  # lista
    assert approvals.check(None, None) is DeviceDecision.UNKNOWN  # sem aparelho: falha fechado
    assert tasks == []  # lista agora: nada a pedir
    await features.refresh()  # a instância antiga: não lista
    hellos.clear()

    assert approvals.check(None, None) is DeviceDecision.UNKNOWN  # nunca vira "API sem aprovação"
    assert len(tasks) == 1
    await asyncio.gather(*tasks)
    assert features.supports("pc.device.v1") and hellos == [1]  # a capacidade volta em segundos

    await features.refresh()  # outra resposta antiga
    assert approvals.check(None, None) is DeviceDecision.UNKNOWN
    assert len(tasks) == 1  # dentro de 15 s: não pede de novo
    clock.now += 16
    assert approvals.check(None, None) is DeviceDecision.UNKNOWN
    assert len(tasks) == 2
    await asyncio.gather(*tasks)
    assert features.supports("pc.device.v1")


async def test_the_seen_flag_is_retried_until_it_is_written(tmp_path: Path) -> None:
    class Flaky(Memory):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        def mark_api_seen(self) -> None:
            self.attempts += 1
            if self.attempts == 1:
                raise OSError("disco")
            self.seen = True

    memory = Flaky()
    approvals = DeviceApprovals(memory, Prompt(), now=Clockwork())
    approvals.bind_api(answered=lambda: True, supports=lambda: True, announce=lambda d, n: None)

    approvals.note_api()  # a gravação falha: a segurança vale na hora, o arquivo fica para depois
    assert memory.attempts == 1 and not memory.seen
    state = {"supports": False}
    approvals.bind_api(
        answered=lambda: True, supports=lambda: state["supports"], announce=lambda d, n: None
    )
    assert approvals.check(None, None) is DeviceDecision.UNKNOWN  # já visto: nunca "sem aprovação"
    state["supports"] = True
    approvals.note_api()  # tenta de novo e agora grava
    assert memory.attempts == 2 and memory.seen
    approvals.note_api()
    assert memory.attempts == 2  # gravado: não repete

    # No arquivo de verdade: a gravação que falha NÃO vira "visto" (a pasta é um arquivo).
    blocked = tmp_path / "ocupado"
    blocked.write_text("x", encoding="utf-8")
    store = JsonDeviceStore(blocked / "pc-devices.json")
    with pytest.raises(OSError):
        store.mark_api_seen()
    assert not store.api_seen()


async def test_the_dead_closer_threads_are_pruned() -> None:
    import threading  # noqa: PLC0415

    def make_prompt() -> WindowsApprovalPrompt:
        releases: dict[str, threading.Event] = {}

        def box(text: str, title: str, flags: int) -> int:
            event = releases.setdefault(title, threading.Event())
            event.wait(10)
            return 7

        def close(title: str) -> bool:
            if title not in releases:
                return False
            releases[title].set()
            return True

        return WindowsApprovalPrompt(box, close)

    prompt = make_prompt()
    for _ in range(3):
        asking = asyncio.ensure_future(prompt.ask("iPhone"))
        await asyncio.sleep(0.05)
        asking.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asking
        await asyncio.sleep(0.2)  # o fechamento termina

    assert len(prompt._closers) <= 1  # as threads mortas saem da lista a cada novo fechamento
    await prompt.aclose()
    assert not prompt._closers
