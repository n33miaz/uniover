"""Zoom da pinça e volume absoluto: handlers, aviso do nível, esquema e o adaptador de áudio.

Nenhum teste toca o áudio nem o mouse de verdade: o áudio é `FakeAudio`, o dispositivo do adaptador
é um dublê e o envio do `SendInput` é um registro.
"""

import asyncio
import ctypes
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest

from uniover_agent.adapters import pc_audio
from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.adapters.pc_audio import WindowsPcAudio, to_percent
from uniover_agent.core import (
    Accepted,
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    Handler,
    PcVolumeAnnouncer,
    Rejected,
    ResultStatus,
    volume_after_hello,
)
from uniover_agent.core.pc import PcApp, pc_handlers, pc_volume_handler, pc_zoom_handler
from uniover_agent.ports import TransportError
from uniover_agent.ports.pc import PcUnsupported, VolumeState

from .support import AGENT_ID, FakeAudio, envelope
from .test_pc_handlers import FakeInput, FakeLauncher, FakePower


def build(audio: FakeAudio | None = None, changed: list[int] | None = None) -> dict[str, Handler]:
    notes = changed if changed is not None else []
    return dict(
        pc_handlers(
            FakeInput(),
            FakePower(),
            FakeLauncher(),
            [PcApp("notas", "Notas", "notepad")],
            shutdown_delay_seconds=30,
            audio=audio or FakeAudio(),
            volume_changed=lambda: notes.append(1),
        )
    )


def command(message_type: str, body: dict[str, Any]) -> Command:
    return Command("1", message_type, body)


# ---- zoom ------------------------------------------------------------------------------------


async def test_the_zoom_handler_asks_the_input_for_that_many_wheel_steps() -> None:
    pc = FakeInput()
    handler = pc_zoom_handler(pc)
    assert (await handler(command("pc.pointer.zoom.v1", {"steps": 3}))).status is ResultStatus.OK
    assert (await handler(command("pc.pointer.zoom.v1", {"steps": -12}))).status is ResultStatus.OK
    assert pc.calls == [("zoom", 3), ("zoom", -12)]


@pytest.mark.parametrize("steps", [0, 13, -13, 1.5, "2", True, None])
async def test_a_zoom_outside_the_contract_is_refused_and_nothing_reaches_the_input(
    steps: object,
) -> None:
    pc = FakeInput()
    result = await pc_zoom_handler(pc)(command("pc.pointer.zoom.v1", {"steps": steps}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")
    assert pc.calls == []


async def test_a_zoom_the_system_cannot_do_is_reported_not_raised() -> None:
    pc = FakeInput()
    pc.error = PcUnsupported("o controle do PC só existe no Windows")
    result = await pc_zoom_handler(pc)(command("pc.pointer.zoom.v1", {"steps": 1}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "unsupported")


async def test_a_zoom_the_windows_cut_short_is_a_failure_not_a_success() -> None:
    pc = FakeInput()
    pc.error = OSError("o Windows aceitou 1 de 5 eventos de entrada")
    result = await pc_zoom_handler(pc)(command("pc.pointer.zoom.v1", {"steps": 3}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")


# ---- volume: o comando -----------------------------------------------------------------------


async def test_the_volume_command_sets_the_level_and_the_mute_in_that_order() -> None:
    audio = FakeAudio()
    handler = pc_volume_handler(audio)
    assert (await handler(command("pc.volume.v1", {"level": 55}))).status is ResultStatus.OK
    assert (await handler(command("pc.volume.v1", {"muted": True}))).status is ResultStatus.OK
    assert (
        await handler(command("pc.volume.v1", {"muted": False, "level": 10}))
    ).status is ResultStatus.OK
    assert audio.calls == [
        ("level", 55),
        ("muted", True),
        ("level", 10),
        ("muted", False),
    ]


async def test_the_volume_command_with_nothing_to_do_is_refused_not_answered_done() -> None:
    audio = FakeAudio()
    result = await pc_volume_handler(audio)(command("pc.volume.v1", {}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")
    assert audio.calls == []


@pytest.mark.parametrize(
    "body",
    [{"level": 101}, {"level": -1}, {"level": 1.5}, {"level": "5"}, {"level": True}, {"muted": 1}],
)
async def test_a_volume_outside_the_contract_changes_nothing(body: dict[str, object]) -> None:
    audio = FakeAudio()
    result = await pc_volume_handler(audio)(command("pc.volume.v1", body))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_message")
    assert audio.calls == []


async def test_a_level_with_a_bad_mute_applies_neither() -> None:
    audio = FakeAudio()
    await pc_volume_handler(audio)(command("pc.volume.v1", {"level": 30, "muted": "sim"}))
    assert audio.calls == [], "o pedido inteiro é recusado, sem aplicar o nível"


async def test_an_audio_failure_is_reported_and_the_change_is_not_announced() -> None:
    audio = FakeAudio()
    audio.failure = OSError("sem dispositivo de saída")
    changed: list[int] = []
    handler = pc_volume_handler(audio, changed=lambda: changed.append(1))
    result = await handler(command("pc.volume.v1", {"level": 10}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "failed")
    audio.failure = PcUnsupported("só no Windows")
    result = await handler(command("pc.volume.v1", {"level": 10}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "unsupported")
    assert changed == []


async def test_a_volume_change_and_the_volume_keys_ask_for_the_announcement() -> None:
    changed: list[int] = []
    handlers = build(changed=changed)
    await handlers["pc.volume.v1"](command("pc.volume.v1", {"level": 20}))
    await handlers["pc.media.v1"](command("pc.media.v1", {"action": "VOLUME_UP", "steps": 2}))
    await handlers["pc.media.v1"](command("pc.media.v1", {"action": "VOLUME_DOWN"}))
    await handlers["pc.media.v1"](command("pc.media.v1", {"action": "MUTE"}))
    assert len(changed) == 4
    await handlers["pc.media.v1"](command("pc.media.v1", {"action": "PLAY_PAUSE"}))
    await handlers["pc.media.v1"](command("pc.media.v1", {"action": "NEXT"}))
    assert len(changed) == 4, "tocar, pausar e trocar de faixa não mexem no volume"


def test_without_an_audio_port_there_is_no_volume_command() -> None:
    handlers = pc_handlers(FakeInput(), FakePower(), FakeLauncher(), [], shutdown_delay_seconds=30)
    assert "pc.volume.v1" not in handlers
    assert "pc.pointer.zoom.v1" in handlers


# ---- esquema do contrato: o portão recusa o que o modelo gerado deixaria passar -----------------


def check(message_type: str, body: dict[str, Any]) -> object:
    return EnvelopeGate(AGENT_ID).check_inbound(json.dumps(envelope(message_type, body)))


@pytest.mark.parametrize(
    ("message_type", "body"),
    [
        ("pc.pointer.zoom.v1", {"steps": 1}),
        ("pc.pointer.zoom.v1", {"steps": -12, "seq": 4, "epoch": "3fa9c10d7be2465a"}),
        ("pc.volume.v1", {"level": 0}),
        ("pc.volume.v1", {"muted": True}),
        ("pc.volume.v1", {"level": 100, "muted": False, "seq": 1}),
    ],
)
def test_the_gate_accepts_the_valid_bodies(message_type: str, body: dict[str, Any]) -> None:
    assert isinstance(check(message_type, body), Accepted)


@pytest.mark.parametrize(
    ("message_type", "body"),
    [
        ("pc.pointer.zoom.v1", {"steps": 0}),
        ("pc.pointer.zoom.v1", {"steps": 13}),
        ("pc.pointer.zoom.v1", {}),
        ("pc.pointer.zoom.v1", {"steps": 1, "modifiers": ["SHIFT"]}),
        ("pc.volume.v1", {}),
        ("pc.volume.v1", {"level": 101}),
        ("pc.volume.v1", {"level": 1.5}),
        ("pc.volume.v1", {"muted": "yes"}),
        ("pc.volume.v1", {"level": 5, "step": 1}),
    ],
)
def test_the_gate_refuses_what_the_contract_refuses(
    message_type: str, body: dict[str, Any]
) -> None:
    assert isinstance(check(message_type, body), Rejected)


def test_the_state_message_is_built_valid_for_the_contract() -> None:
    # O tipo `pc.volume.state.v1` é do agente para a API: o portão do agente também o valida.
    gate = EnvelopeGate(AGENT_ID)
    clock = FakeClock()
    message = EnvelopeFactory(AGENT_ID, gate, clock).pc_volume_state(40, True)
    assert message["type"] == "pc.volume.state.v1"
    assert (message["body"]["level"], message["body"]["muted"]) == (40, True)


# ---- o aviso do nível --------------------------------------------------------------------------


class Lab:
    def __init__(self, *, enabled: bool = True, audio: FakeAudio | None = None) -> None:
        self.audio = audio or FakeAudio(level=40)
        self.transport = FakeTransport()
        self.clock = FakeClock()
        self.listed = enabled
        gate = EnvelopeGate(AGENT_ID)
        self.announcer = PcVolumeAnnouncer(
            self.audio,
            self.transport,
            EnvelopeFactory(AGENT_ID, gate, self.clock),
            self.clock,
            enabled=lambda: self.listed,
            watch_seconds=5.0,
            settle_seconds=0.2,
        )

    def states(self) -> list[tuple[int, bool]]:
        return [
            (m["body"]["level"], m["body"]["muted"])
            for m in self.transport.sent
            if m["type"] == "pc.volume.state.v1"
        ]


async def test_nothing_is_sent_until_the_api_lists_the_capability() -> None:
    lab = Lab(enabled=False)
    await lab.announcer.announce(force=True)
    await volume_after_hello(lab.announcer)()
    assert lab.transport.sent == []
    lab.listed = True
    await lab.announcer.announce()
    assert lab.states() == [(40, False)]


async def test_the_level_is_announced_after_every_hello_even_if_it_did_not_change() -> None:
    lab = Lab()
    after_hello = volume_after_hello(lab.announcer)
    await after_hello()
    await after_hello()
    assert lab.states() == [(40, False), (40, False)], "a conexão nova começa sem nada na API"


async def test_the_periodic_read_only_sends_what_changed() -> None:
    lab = Lab()
    await lab.announcer.announce(force=True)
    await lab.announcer.announce()
    await lab.announcer.announce()
    assert lab.states() == [(40, False)]
    lab.audio.level = 55  # o teclado do próprio PC
    await lab.announcer.announce()
    lab.audio.muted = True
    await lab.announcer.announce()
    assert lab.states() == [(40, False), (55, False), (55, True)]


async def test_an_unreadable_audio_sends_nothing_and_never_raises() -> None:
    lab = Lab()
    lab.audio.failure = PcUnsupported("só no Windows")
    await lab.announcer.announce(force=True)
    lab.audio.failure = OSError("sem dispositivo")
    await lab.announcer.announce(force=True)
    assert lab.transport.sent == []


async def test_a_connection_that_drops_mid_send_is_tried_again_by_the_next_announcement() -> None:
    lab = Lab()
    real_send = lab.transport.send
    failing = {"on": True}

    async def send(message: dict[str, Any]) -> None:
        if failing["on"]:
            raise TransportError("caiu")
        await real_send(message)

    lab.transport.send = send  # type: ignore[method-assign]
    await lab.announcer.announce()
    assert lab.states() == []
    failing["on"] = False
    await lab.announcer.announce()
    assert lab.states() == [(40, False)], "o que não saiu não conta como enviado"


async def test_a_burst_of_changes_becomes_one_announcement_after_the_settle_time() -> None:
    lab = Lab()
    await lab.announcer.announce(force=True)
    lab.audio.level = 60
    lab.announcer.soon()
    lab.announcer.soon()
    lab.announcer.soon()
    for _ in range(5):
        await asyncio.sleep(0)
    assert lab.clock.sleeps == [0.2], "um aviso só espera o Windows aplicar a tecla"
    assert lab.states() == [(40, False), (60, False)]
    await lab.announcer.aclose()


async def test_the_periodic_job_reads_every_few_seconds_and_stops_when_cancelled() -> None:
    lab = Lab()
    job = asyncio.ensure_future(lab.announcer.run())
    for _ in range(4):
        await asyncio.sleep(0)
    lab.audio.level = 70
    for _ in range(4):
        await asyncio.sleep(0)
    job.cancel()
    with pytest.raises(asyncio.CancelledError):
        await job
    assert set(lab.clock.sleeps) == {5.0}
    assert (70, False) in lab.states()


async def test_binding_the_gate_late_switches_the_announcement_on() -> None:
    lab = Lab(enabled=False)
    await lab.announcer.announce(force=True)
    assert lab.transport.sent == []
    lab.announcer.bind_enabled(lambda: True)
    await lab.announcer.announce(force=True)
    assert lab.states() == [(40, False)]


# ---- o adaptador do Windows (dispositivo de mentira) ----------------------------------------


class FakeEndpoint:
    def __init__(self) -> None:
        self.scalar = 0.375
        self.mute = False
        self.calls: list[tuple[str, float | bool]] = []

    def get_scalar(self) -> float:
        return self.scalar

    def set_scalar(self, value: float) -> None:
        self.calls.append(("scalar", value))
        self.scalar = value

    def get_mute(self) -> bool:
        return self.mute

    def set_mute(self, muted: bool) -> None:
        self.calls.append(("mute", muted))
        self.mute = muted


class Devices:
    """Abre e fecha o dispositivo de mentira: confere que cada chamada o libera."""

    def __init__(self) -> None:
        self.endpoint = FakeEndpoint()
        self.opened = 0
        self.closed = 0

    @contextmanager
    def __call__(self) -> Iterator[FakeEndpoint]:
        self.opened += 1
        try:
            yield self.endpoint
        finally:
            self.closed += 1


def test_the_adapter_reads_the_level_as_a_whole_percent_and_the_mute() -> None:
    devices = Devices()
    audio = WindowsPcAudio(devices)
    assert audio.read() == VolumeState(38, False)  # 0,375 arredonda para 38
    devices.endpoint.scalar = 1.0
    devices.endpoint.mute = True
    assert audio.read() == VolumeState(100, True)
    assert devices.opened == devices.closed == 2


def test_the_adapter_sets_the_level_as_a_fraction_without_touching_the_mute() -> None:
    devices = Devices()
    WindowsPcAudio(devices).set_level(37)
    assert devices.endpoint.calls == [("scalar", 0.37)]
    assert devices.endpoint.mute is False


def test_the_adapter_sets_the_mute_without_toggling_and_without_touching_the_level() -> None:
    devices = Devices()
    audio = WindowsPcAudio(devices)
    audio.set_muted(True)
    audio.set_muted(True)
    audio.set_muted(False)
    assert devices.endpoint.calls == [("mute", True), ("mute", True), ("mute", False)]
    assert devices.endpoint.scalar == 0.375


@pytest.mark.parametrize("level", [-1, 101, True])
def test_the_adapter_refuses_a_level_outside_zero_to_one_hundred_before_opening_anything(
    level: int,
) -> None:
    devices = Devices()
    with pytest.raises(ValueError, match="fora de 0 a 100"):
        WindowsPcAudio(devices).set_level(level)
    assert devices.opened == 0


def test_the_device_is_released_even_when_the_call_fails() -> None:
    devices = Devices()

    def broken() -> float:
        raise OSError("o Windows recusou")

    devices.endpoint.get_scalar = broken  # type: ignore[method-assign]
    with pytest.raises(OSError, match="recusou"):
        WindowsPcAudio(devices).read()
    assert devices.opened == devices.closed == 1


@pytest.mark.parametrize(
    ("scalar", "percent"),
    [
        (0.0, 0),
        (0.004, 0),
        (0.005, 0),
        (0.0051, 1),
        (0.5, 50),
        (0.995, 100),
        (1.0, 100),
        (1.2, 100),
        (-0.1, 0),
    ],
)
def test_the_percent_is_rounded_and_kept_inside_the_range(scalar: float, percent: int) -> None:
    assert to_percent(scalar) == percent


def test_building_the_adapter_makes_no_call_to_the_system(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden() -> object:
        raise AssertionError("construir não pode abrir o áudio")

    monkeypatch.setattr(pc_audio, "_open_core_audio", forbidden)
    WindowsPcAudio()  # nada abre ao construir


@pytest.mark.skipif(sys.platform == "win32", reason="fora do Windows o sistema recusa")
def test_outside_windows_the_audio_is_refused() -> None:
    with pytest.raises(PcUnsupported):
        WindowsPcAudio().read()
    with pytest.raises(PcUnsupported):
        WindowsPcAudio().set_level(10)


def test_the_core_audio_table_positions_match_the_windows_headers() -> None:
    # Um índice errado chamaria outro método (e mexeria no que não devia): os números vêm de
    # `mmdeviceapi.h` e `endpointvolume.h` (0 a 2 são o IUnknown) e ficam fixos aqui.
    assert pc_audio._RELEASE == 2
    assert pc_audio._ENUMERATOR_GET_DEFAULT_AUDIO_ENDPOINT == 4
    assert pc_audio._DEVICE_ACTIVATE == 3
    assert pc_audio._VOLUME_SET_MASTER_VOLUME_LEVEL_SCALAR == 7
    assert pc_audio._VOLUME_GET_MASTER_VOLUME_LEVEL_SCALAR == 9
    assert pc_audio._VOLUME_SET_MUTE == 14
    assert pc_audio._VOLUME_GET_MUTE == 15
    assert (pc_audio._E_RENDER, pc_audio._E_MULTIMEDIA) == (0, 1)


@pytest.mark.skipif(sys.platform != "win32", reason="o GUID nativo só existe no Windows")
def test_the_guids_have_the_native_byte_layout_without_calling_the_system() -> None:
    if sys.platform == "win32":
        guid = bytes(pc_audio._guid(pc_audio._IID_IAUDIO_ENDPOINT_VOLUME))
        assert guid.hex() == "822cdf5c1e84464597220cf74078229a"


@pytest.mark.skipif(
    sys.platform != "win32", reason="a tabela virtual COM nativa só existe no Windows"
)
def test_every_com_call_turns_a_failure_hresult_into_an_error_and_never_a_value() -> None:
    e_fail = -2147467259  # 0x80004005
    calls: list[str] = []
    prototypes = {
        "get": ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p),
        "set": ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_float, ctypes.c_void_p),
    }

    def failing_get(this: object, out: object) -> int:
        calls.append("get")
        return e_fail

    def failing_set(this: object, value: float, context: object) -> int:
        calls.append("set")
        return e_fail

    def succeeding_get(this: object, out: int) -> int:
        calls.append("ok")
        ctypes.c_float.from_address(out).value = 0.5
        return 0

    get_fn, set_fn, ok_fn = (
        prototypes["get"](failing_get),
        prototypes["set"](failing_set),
        prototypes["get"](succeeding_get),
    )
    # A tabela: três do IUnknown e, nas posições dos métodos de volume, os nossos.
    table = (ctypes.c_void_p * 16)()
    table[pc_audio._VOLUME_GET_MASTER_VOLUME_LEVEL_SCALAR] = ctypes.cast(get_fn, ctypes.c_void_p)
    table[pc_audio._VOLUME_SET_MASTER_VOLUME_LEVEL_SCALAR] = ctypes.cast(set_fn, ctypes.c_void_p)
    table[pc_audio._VOLUME_GET_MUTE] = ctypes.cast(get_fn, ctypes.c_void_p)
    table[pc_audio._VOLUME_SET_MUTE] = ctypes.cast(set_fn, ctypes.c_void_p)
    obj = ctypes.c_void_p(ctypes.addressof(table))
    endpoint = pc_audio._CoreEndpoint(pc_audio._Com(ctypes.c_void_p(ctypes.addressof(obj))))

    with pytest.raises(OSError):
        endpoint.get_scalar()
    with pytest.raises(OSError):
        endpoint.set_scalar(0.4)
    with pytest.raises(OSError):
        endpoint.get_mute()
    with pytest.raises(OSError):
        endpoint.set_mute(True)
    assert calls[:3] == ["get", "set", "get"]

    # Um HRESULT de sucesso segue devolvendo o valor lido.
    table[pc_audio._VOLUME_GET_MASTER_VOLUME_LEVEL_SCALAR] = ctypes.cast(ok_fn, ctypes.c_void_p)
    assert endpoint.get_scalar() == 0.5
