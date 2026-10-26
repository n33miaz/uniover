"""Adaptador do Remote v2: contra a biblioteca real (TV falsa em loopback) e contra um duplo.

Nada aqui fala com uma TV de verdade. A TV falsa fala o protocolo, então cobre a biblioteca; o
que só uma TV real responde (TGuard, Netflix, tempo de religação) está nas medições pendentes.
"""

import asyncio
import socket
import typing
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from androidtvremote2 import (
    AndroidTVRemote,
    CannotConnect,
    ConnectionClosed,
    InvalidAuth,
    VolumeInfo,
)
from androidtvremote2.remotemessage_pb2 import RemoteDirection, RemoteKeyCode

from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tv_remote_v2 import (
    DIRECTIONS,
    KEY_CODES,
    AndroidTvRemoteV2,
    RemoteClient,
    _lost_future,
    volume_percent,
)
from uniover_agent.contracts.tv_key_v1 import TvKeyV1BodyKey
from uniover_agent.contracts.tv_key_v2 import TvKeyV2BodyKey
from uniover_agent.core import SessionState, TvSessionManager
from uniover_agent.ports import TvNotPaired, TvPortClosed, TvUnreachable

from .support_tv import FakeTvServer, write_certificate


def contract_keys(model: type[Any]) -> tuple[str, ...]:
    """As teclas do enum do contrato, lidas do `Literal` gerado (nada copiado à mão)."""
    return typing.get_args(model.model_fields["root"].annotation)


def real_factory(port: int) -> Callable[[str, str, str, str], RemoteClient]:
    def build(name: str, certfile: str, keyfile: str, host: str) -> RemoteClient:
        return AndroidTVRemote(name, certfile, keyfile, "127.0.0.1", api_port=port)

    return build


def make_adapter(tmp_path: Path, port: int, **kwargs: Any) -> AndroidTvRemoteV2:
    cert_dir = tmp_path / "cert"
    write_certificate(cert_dir, "UniOver")
    return AndroidTvRemoteV2(
        "127.0.0.1", "UniOver", cert_dir, client_factory=real_factory(port), **kwargs
    )


async def eventually(condition: Callable[[], bool], seconds: float = 3.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("a condição não ficou verdadeira a tempo")


# --- mapeamento de teclas -----------------------------------------------------------------------


def test_every_contract_key_has_an_android_keycode_the_library_knows() -> None:
    keys = set(contract_keys(TvKeyV2BodyKey)) | set(contract_keys(TvKeyV1BodyKey))
    assert len(contract_keys(TvKeyV2BodyKey)) == 28
    assert keys == set(KEY_CODES)
    for key in keys:
        # `Value` levanta ValueError se a biblioteca não conhecer o nome.
        assert RemoteKeyCode.Value(KEY_CODES[key]) > 0


def test_mapping_spot_checks() -> None:
    assert KEY_CODES["UP"] == "KEYCODE_DPAD_UP"
    assert KEY_CODES["OK"] == "KEYCODE_DPAD_CENTER"
    assert KEY_CODES["MUTE"] == "KEYCODE_VOLUME_MUTE"
    assert KEY_CODES["NUM_7"] == "KEYCODE_7"
    assert KEY_CODES["INPUT"] == "KEYCODE_TV_INPUT"
    assert DIRECTIONS == {"SHORT", "START_LONG", "END_LONG"}


def test_volume_percent_converts_the_tvs_scale() -> None:
    assert volume_percent({"level": 15, "max": 30, "muted": False}) == 50
    assert volume_percent({"level": 0, "max": 100, "muted": True}) == 0
    assert volume_percent({"level": 400, "max": 100, "muted": False}) == 100
    assert volume_percent({"level": 5, "max": 0, "muted": False}) is None


# --- contra a biblioteca real e a TV falsa ------------------------------------------------------


async def test_library_still_exposes_the_connection_lost_future_the_adapter_relies_on(
    tmp_path: Path,
) -> None:
    """Se uma atualização da biblioteca mover o atributo interno, este teste falha alto."""
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            assert _lost_future(adapter._client) is not None
        finally:
            await adapter.disconnect()
    assert _lost_future(object()) is None


async def test_connects_and_translates_the_pushed_state(tmp_path: Path) -> None:
    power: list[bool] = []
    volume: list[int | None] = []
    apps: list[str] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_power(power.append)
        adapter.on_volume(volume.append)
        adapter.on_app(apps.append)
        assert not adapter.connected
        await adapter.connect()
        try:
            assert adapter.connected
            await eventually(lambda: bool(volume) and bool(apps))
        finally:
            await adapter.disconnect()
    assert power == [True]
    assert volume == [20]
    assert apps == ["com.exemplo.video"]
    assert not adapter.connected


async def test_keys_and_links_reach_the_tv_as_the_right_android_codes(tmp_path: Path) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            await adapter.send_key("HOME")
            await adapter.send_key("UP", "START_LONG")
            await adapter.send_key("NUM_3", "END_LONG")
            await adapter.launch_link("https://www.youtube.com/watch?v=abc")
            await eventually(lambda: len(server.keys) == 3 and len(server.links) == 1)
        finally:
            await adapter.disconnect()
    assert server.keys == [
        (RemoteKeyCode.Value("KEYCODE_HOME"), RemoteDirection.Value("SHORT")),
        (RemoteKeyCode.Value("KEYCODE_DPAD_UP"), RemoteDirection.Value("START_LONG")),
        (RemoteKeyCode.Value("KEYCODE_3"), RemoteDirection.Value("END_LONG")),
    ]
    assert server.links == ["https://www.youtube.com/watch?v=abc"]


async def test_text_reaches_the_tv_as_the_whole_field_value(tmp_path: Path) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            await adapter.send_text("olá")
            await adapter.send_text("olá mundo")
            await eventually(lambda: len(server.texts) == 2)
        finally:
            await adapter.disconnect()
    # Cada envio carrega o campo inteiro: o segundo substitui o primeiro, não se acrescenta a ele.
    assert server.texts == ["olá", "olá mundo"]


async def test_empty_text_is_a_programming_error_and_nothing_is_sent(tmp_path: Path) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            with pytest.raises(ValueError, match="texto vazio"):
                await adapter.send_text("")
            await asyncio.sleep(0.1)
        finally:
            await adapter.disconnect()
    assert server.texts == []


async def test_every_key_goes_on_the_wire(tmp_path: Path) -> None:
    # `POWER` inclusive: o agente a envia como as demais (a TV aqui é a falsa, em loopback).
    keys = list(KEY_CODES)
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            for key in keys:
                await adapter.send_key(key)
            await eventually(lambda: len(server.keys) == len(keys))
        finally:
            await adapter.disconnect()
    expected = [RemoteKeyCode.Value(KEY_CODES[key]) for key in keys]
    assert [code for code, _ in server.keys] == expected


async def test_the_edit_key_that_erases_goes_on_the_wire_as_the_androids_del(
    tmp_path: Path,
) -> None:
    # `DEL` não é do contrato de teclas (a API não o envia); só o agente o usa para apagar.
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            await adapter.send_key("DEL")
            await eventually(lambda: len(server.keys) == 1)
        finally:
            await adapter.disconnect()
    assert [code for code, _ in server.keys] == [RemoteKeyCode.Value("KEYCODE_DEL")]
    assert "DEL" not in KEY_CODES


async def test_the_typing_keys_go_on_the_wire_as_the_androids_letter_and_punctuation_keys(
    tmp_path: Path,
) -> None:
    # `TYPE_*` não é do contrato de teclas: só o agente usa, para digitar sem o ADB.
    names = [
        "TYPE_A",
        "TYPE_Z",
        "TYPE_SPACE",
        "TYPE_PERIOD",
        "TYPE_COMMA",
        "TYPE_MINUS",
        "TYPE_SLASH",
    ]
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            for name in names:
                await adapter.send_key(name)
            await eventually(lambda: len(server.keys) == len(names))
        finally:
            await adapter.disconnect()
    assert [code for code, _ in server.keys] == [
        RemoteKeyCode.Value(f"KEYCODE_{suffix}")
        for suffix in ["A", "Z", "SPACE", "PERIOD", "COMMA", "MINUS", "SLASH"]
    ]
    assert not [name for name in names if name in KEY_CODES]


async def test_an_unknown_typing_key_is_refused_without_naming_the_character(
    tmp_path: Path,
) -> None:
    adapter = duplo_adapter(tmp_path, FakeLibrary())
    await adapter.connect()
    with pytest.raises(ValueError, match="tecla desconhecida") as caught:
        await adapter.send_key("TYPE_SENHA")
    assert "SENHA" not in str(caught.value)
    await adapter.disconnect()


async def test_a_dropped_connection_is_detected_and_keys_are_refused(tmp_path: Path) -> None:
    availability: list[bool] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_available(availability.append)
        await adapter.connect()
        try:
            server.drop_all()
            await eventually(lambda: availability == [False])
            assert not adapter.connected
            # A biblioteca descartaria esta tecla em silêncio; o adaptador recusa em voz alta.
            with pytest.raises(TvUnreachable):
                await adapter.send_key("HOME")
            with pytest.raises(TvUnreachable):
                await adapter.launch_link("https://exemplo.test/a")
            with pytest.raises(TvUnreachable):
                await adapter.send_text("oi")
        finally:
            await adapter.disconnect()


async def test_connecting_again_after_a_drop_works(tmp_path: Path) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        server.drop_all()
        await eventually(lambda: not adapter.connected)
        await adapter.connect()
        try:
            await adapter.send_key("BACK")
            await eventually(lambda: len(server.keys) == 1)
        finally:
            await adapter.disconnect()
        assert server.connections == 2


async def test_voluntary_disconnect_does_not_report_unavailable(tmp_path: Path) -> None:
    availability: list[bool] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_available(availability.append)
        await adapter.connect()
        await adapter.disconnect()
        await adapter.disconnect()  # idempotente
        await asyncio.sleep(0.1)
    assert availability == []
    assert not adapter.connected


async def test_a_tv_that_never_answers_is_given_up_on_after_the_timeout(tmp_path: Path) -> None:
    # A biblioteca espera `remote_start` sem limite; o adaptador precisa impor o dele.
    async with FakeTvServer(tmp_path, send_start=False) as server:
        adapter = make_adapter(tmp_path, server.port, connect_timeout=0.3)
        with pytest.raises(TvUnreachable) as caught:
            await adapter.connect()
        # Sem resposta é "não sei" (standby, rede): não se confunde com porta fechada.
        assert not isinstance(caught.value, TvPortClosed)
        assert not adapter.connected


async def test_closed_port_means_the_service_is_down(tmp_path: Path) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    adapter = make_adapter(tmp_path, port, connect_timeout=8.0)  # o Windows leva ~2 s para desistir
    # Recusa ativa: a TV está na rede e o serviço do controle morreu (pede reparo).
    with pytest.raises(TvPortClosed):
        await adapter.connect()


async def test_missing_certificate_means_not_paired(tmp_path: Path) -> None:
    adapter = AndroidTvRemoteV2("127.0.0.1", "UniOver", tmp_path / "vazio")
    with pytest.raises(TvNotPaired):
        await adapter.connect()


async def test_session_manager_recovers_by_itself_when_the_tv_drops_the_service(
    tmp_path: Path,
) -> None:
    """Ponta a ponta sem TV real: gerenciador + adaptador + biblioteca + TV falsa."""
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        manager = TvSessionManager(SystemClock(), adapter, backoff=(0.01, 0.01, 0.01))
        await manager.send_key("HOME")
        await eventually(lambda: manager.snapshot().volume == 20 and len(server.keys) == 1)
        assert manager.snapshot().power == "on"

        server.drop_all()
        await eventually(lambda: server.connections == 2 and adapter.connected)
        await manager.settle()
        assert manager.state is SessionState.HOT

        await manager.send_key("BACK")
        await eventually(lambda: len(server.keys) == 2)
        await manager.aclose()
        assert not adapter.connected
        assert manager.snapshot().power == "unknown"
        assert manager.snapshot().connection == "hibernating"


async def test_after_power_the_tv_reports_standby_and_the_agent_sends_no_other_key(
    tmp_path: Path,
) -> None:
    """A TV avisa que desligou e fecha a sessão (ainda atende o serviço), sem TV real."""
    power = (RemoteKeyCode.Value("KEYCODE_POWER"), RemoteDirection.Value("SHORT"))
    async with FakeTvServer(tmp_path, standby_on_power=True) as server:
        adapter = make_adapter(tmp_path, server.port)
        manager = TvSessionManager(SystemClock(), adapter, backoff=(0.01, 0.01, 0.01))
        states: list[tuple[str, str]] = []
        manager.subscribe(lambda state: states.append((state.power, state.connection)))
        await manager.wake()
        await eventually(lambda: manager.snapshot().power == "on")

        await manager.send_key("POWER")
        # A TV disse "desligada" com a sessão aberta, derrubou a sessão, e o agente reabriu uma vez.
        await eventually(lambda: server.connections == 2 and adapter.connected)
        await manager.settle()
        await eventually(
            lambda: (manager.snapshot().power, manager.snapshot().connection) == ("off", "hot")
        )
        assert states.index(("off", "hot")) < states.index(("unknown", "disconnected"))

        # O app segue pedindo para aquecer e chega um toque duplo: nem tecla nem conexão nova.
        for _ in range(3):
            await manager.wake()
        await manager.send_key("POWER")
        await asyncio.sleep(0.2)
        assert server.keys == [power]
        assert server.connections == 2
        assert manager.state is SessionState.HOT
        await manager.aclose()


# --- contra um duplo da biblioteca --------------------------------------------------------------


class FakeLibrary:
    """Duplo de `AndroidTVRemote` para os caminhos que a TV falsa não reproduz."""

    def __init__(self, connect_error: Exception | None = None) -> None:
        self.connect_error = connect_error
        self.send_error: Exception | None = None
        self.disconnects = 0
        self.sent: list[tuple[int | str, int | str]] = []
        self.texts: list[str] = []
        self._volume: list[Callable[[VolumeInfo], None]] = []
        self._app: list[Callable[[str], None]] = []
        self._power: list[Callable[[bool], None]] = []

    def add_is_on_updated_callback(self, callback: Callable[[bool], None]) -> None:
        self._power.append(callback)

    def add_current_app_updated_callback(self, callback: Callable[[str], None]) -> None:
        self._app.append(callback)

    def add_volume_info_updated_callback(self, callback: Callable[[VolumeInfo], None]) -> None:
        self._volume.append(callback)

    async def async_connect(self) -> None:
        if self.connect_error is not None:
            raise self.connect_error

    def disconnect(self) -> None:
        self.disconnects += 1

    def send_key_command(self, key_code: int | str, direction: int | str = "SHORT") -> None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append((key_code, direction))

    def send_launch_app_command(self, app_link_or_app_id: str) -> None:
        if self.send_error is not None:
            raise self.send_error

    def send_text(self, text: str) -> None:
        if self.send_error is not None:
            raise self.send_error
        self.texts.append(text)


def duplo_adapter(tmp_path: Path, library: FakeLibrary) -> AndroidTvRemoteV2:
    write_certificate(tmp_path, "UniOver")
    return AndroidTvRemoteV2("10.0.0.4", "UniOver", tmp_path, client_factory=lambda *_args: library)


async def test_rejected_certificate_means_not_paired_and_closes_the_library(
    tmp_path: Path,
) -> None:
    library = FakeLibrary(InvalidAuth("Need to pair"))
    adapter = duplo_adapter(tmp_path, library)
    with pytest.raises(TvNotPaired):
        await adapter.connect()
    assert library.disconnects >= 1
    assert not adapter.connected


def cannot_connect(cause: BaseException | None) -> CannotConnect:
    error = CannotConnect("x")
    error.__cause__ = cause
    return error


@pytest.mark.parametrize(
    "error",
    [
        cannot_connect(TimeoutError()),
        cannot_connect(OSError("rede inacessível")),
        cannot_connect(None),
        ConnectionClosed("x"),
        OSError("x"),
    ],
)
async def test_connection_errors_mean_unreachable_but_not_a_closed_port(
    tmp_path: Path, error: Exception
) -> None:
    adapter = duplo_adapter(tmp_path, FakeLibrary(error))
    with pytest.raises(TvUnreachable) as caught:
        await adapter.connect()
    assert not isinstance(caught.value, TvPortClosed)


async def test_refused_connection_means_a_closed_port(tmp_path: Path) -> None:
    adapter = duplo_adapter(tmp_path, FakeLibrary(cannot_connect(ConnectionRefusedError())))
    with pytest.raises(TvPortClosed):
        await adapter.connect()


async def test_error_text_from_the_library_never_reaches_the_message(tmp_path: Path) -> None:
    adapter = duplo_adapter(tmp_path, FakeLibrary(CannotConnect("código-secreto-123")))
    with pytest.raises(TvUnreachable) as caught:
        await adapter.connect()
    assert "secreto" not in str(caught.value)


async def test_unknown_key_and_direction_are_programming_errors(tmp_path: Path) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    await adapter.connect()
    with pytest.raises(ValueError, match="tecla desconhecida"):
        await adapter.send_key("EXPLODIR")
    with pytest.raises(ValueError, match="direção desconhecida"):
        await adapter.send_key("HOME", "DOUBLE")
    assert library.sent == []
    await adapter.disconnect()


async def test_send_without_a_session_is_unreachable(tmp_path: Path) -> None:
    adapter = duplo_adapter(tmp_path, FakeLibrary())
    with pytest.raises(TvUnreachable):
        await adapter.send_key("HOME")
    with pytest.raises(TvUnreachable):
        await adapter.send_text("oi")


async def test_library_closed_error_during_send_means_unreachable(tmp_path: Path) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    await adapter.connect()
    library.send_error = ConnectionClosed("fechou")
    with pytest.raises(TvUnreachable):
        await adapter.send_key("HOME")
    with pytest.raises(TvUnreachable):
        await adapter.launch_link("https://exemplo.test/a")
    with pytest.raises(TvUnreachable):
        await adapter.send_text("oi")
    await adapter.disconnect()


async def test_a_broken_listener_does_not_silence_the_others(tmp_path: Path) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    seen: list[bool] = []

    def broken(value: bool) -> None:
        raise RuntimeError("ouvinte quebrado")

    adapter.on_power(broken)
    adapter.on_power(seen.append)
    await adapter.connect()
    library._power[0](True)
    assert seen == [True]
    await adapter.disconnect()


async def test_volume_without_a_valid_scale_is_not_reported(tmp_path: Path) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    seen: list[int | None] = []
    adapter.on_volume(seen.append)
    await adapter.connect()
    library._volume[0]({"level": 3, "max": 0, "muted": False})
    library._volume[0]({"level": 3, "max": 10, "muted": False})
    assert seen == [30]
    await adapter.disconnect()


async def test_successful_connection_notifies_identity_learning_without_sending_commands(
    tmp_path: Path,
) -> None:
    write_certificate(tmp_path, "UniOver")
    library = FakeLibrary()
    learned = 0

    async def on_connected() -> None:
        nonlocal learned
        learned += 1

    adapter = AndroidTvRemoteV2(
        "10.0.0.4",
        "UniOver",
        tmp_path,
        client_factory=lambda *_args: library,
        on_connected=on_connected,
    )
    await adapter.connect()
    await adapter.disconnect()
    await adapter.connect()
    await adapter.disconnect()
    assert learned == 2
    assert library.sent == []
    assert library.texts == []
