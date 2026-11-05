"""Adaptador do Remote v2: contra a biblioteca real (TV falsa em loopback) e contra um duplo.

Nada aqui fala com uma TV de verdade. A TV falsa fala o protocolo, então cobre a biblioteca; o
que só uma TV real responde (TGuard, Netflix, tempo de religação) está nas medições pendentes.
"""

import asyncio
import logging
import socket
import types
import typing
import unicodedata
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
from androidtvremote2.remotemessage_pb2 import RemoteDirection, RemoteKeyCode, RemoteMessage

from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tv_remote_v2 import (
    DIRECTIONS,
    KEY_CODES,
    AndroidTvRemoteV2,
    RemoteClient,
    _install_text_field_hook,
    _lost_future,
    volume_percent,
)
from uniover_agent.contracts.tv_key_v1 import TvKeyV1BodyKey
from uniover_agent.contracts.tv_key_v2 import TvKeyV2BodyKey
from uniover_agent.core import SessionState, TvSessionManager
from uniover_agent.ports import TextFieldStatus, TvNotPaired, TvPortClosed, TvUnreachable

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


async def test_text_reaches_the_tv_as_the_inserted_chunks(tmp_path: Path) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            await adapter.send_text("olá")
            await adapter.send_text("olá mundo")
            await eventually(lambda: len(server.texts) == 2)
        finally:
            await adapter.disconnect()
    # Cada envio carrega só o trecho que o reconciliador pediu para inserir.
    assert server.texts == ["olá", "olá mundo"]


@pytest.mark.parametrize(
    ("cursor_mode", "expected_cursor"),
    [("library", 7), ("chunk_end", 8), ("field_end", 13)],
)
async def test_ime_batches_use_the_echo_counters_and_the_configured_cursor(
    tmp_path: Path, cursor_mode: str, expected_cursor: int
) -> None:
    fields: list[TextFieldStatus] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port, text_cursor=cursor_mode)
        adapter.on_text_field(fields.append)
        await adapter.connect()
        try:
            server.push_text_field("abcde", counter=17, start=5, end=5, app_counter=29)
            await eventually(lambda: bool(fields))
            protocol = adapter._client._remote_message_protocol
            assert (protocol.ime_counter, protocol.ime_field_counter) == (29, 17)
            await adapter.send_text("café 123")
            await adapter.send_text("ação")
            await eventually(lambda: len(server.ime_batches) == 2)
        finally:
            await adapter.disconnect()
    first, second = [message.remote_ime_batch_edit for message in server.ime_batches]
    assert (first.ime_counter, first.field_counter) == (29, 17)
    assert first.edit_info[0].insert == 1
    assert (
        first.edit_info[0].text_field_status.value,
        first.edit_info[0].text_field_status.start,
        first.edit_info[0].text_field_status.end,
    ) == ("café 123", expected_cursor, expected_cursor)
    assert second.edit_info[0].text_field_status.value == "ação"
    assert first.edit_info[0].text_field_status.value.encode("utf-8") == b"caf\xc3\xa9 123"
    assert second.edit_info[0].text_field_status.value.encode("utf-8") == b"a\xc3\xa7\xc3\xa3o"
    assert all(
        unicodedata.is_normalized("NFC", edit.text_field_status.value)
        for batch in (first, second)
        for edit in batch.edit_info
    )


async def test_ime_batch_without_an_echo_uses_the_library_counters_and_hides_text_in_the_log(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            protocol = adapter._client._remote_message_protocol
            protocol.ime_counter = 3
            protocol.ime_field_counter = 5
            with caplog.at_level("INFO"):
                await adapter.send_text("segredo de teste")
            await eventually(lambda: len(server.ime_batches) == 1)
        finally:
            await adapter.disconnect()
    batch = server.ime_batches[0].remote_ime_batch_edit
    assert (batch.ime_counter, batch.field_counter) == (3, 5)
    assert "cego=sim" in caplog.text
    assert "segredo de teste" not in caplog.text


async def test_ime_batch_disables_the_library_debug_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent_with_debug: list[bool] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            protocol = adapter._client._remote_message_protocol
            original = protocol._send_message

            def record(message: RemoteMessage, should_debug_log: bool = True) -> None:
                sent_with_debug.append(should_debug_log)
                original(message, should_debug_log)

            monkeypatch.setattr(protocol, "_send_message", record)
            await adapter.send_text("texto privado")
            await eventually(lambda: len(server.ime_batches) == 1)
        finally:
            await adapter.disconnect()
    assert sent_with_debug == [False]


async def test_ime_batch_refreshes_the_library_idle_timer(tmp_path: Path) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    await adapter.connect()
    try:
        await adapter.send_text("teste")
    finally:
        await adapter.disconnect()
    assert library._remote_message_protocol.idle_resets == 1


async def test_reconnecting_clears_protocol_counters_before_the_first_blind_batch(
    tmp_path: Path,
) -> None:
    library = FakeLibrary()
    adapter = duplo_adapter(tmp_path, library)
    await adapter.connect()
    protocol = library._remote_message_protocol
    protocol.ime_counter = 17
    protocol.ime_field_counter = 23
    await adapter.disconnect()
    await adapter.connect()
    try:
        await adapter.send_text("novo")
    finally:
        await adapter.disconnect()
    batch = protocol.messages[-1].remote_ime_batch_edit
    assert (batch.ime_counter, batch.field_counter) == (0, 0)


async def test_a_new_echo_between_batches_supplies_the_second_batches_counters(
    tmp_path: Path,
) -> None:
    fields: list[TextFieldStatus] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_text_field(fields.append)
        await adapter.connect()
        try:
            server.push_text_field("a", counter=2, start=1, end=1, app_counter=3)
            await eventually(lambda: len(fields) == 1)
            await adapter.send_text("b")
            await eventually(lambda: len(server.ime_batches) == 1)
            server.push_text_field("ab", counter=7, start=2, end=2, app_counter=11)
            await eventually(lambda: len(fields) == 2)
            await adapter.send_text("c")
            await eventually(lambda: len(server.ime_batches) == 2)
        finally:
            await adapter.disconnect()
    batches = [message.remote_ime_batch_edit for message in server.ime_batches]
    assert [(batch.ime_counter, batch.field_counter) for batch in batches] == [(3, 2), (11, 7)]


async def test_ime_batch_from_the_tv_is_inherited_by_a_field_echo_without_app_info(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    fields: list[TextFieldStatus] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_text_field(fields.append)
        await adapter.connect()
        try:
            server.push_text_field("a", counter=2, start=1, end=1, app_counter=3)
            await eventually(lambda: len(fields) == 1)
            server.push_ime_batch(11, 7)
            await eventually(lambda: (adapter._ime_counter, adapter._field_counter) == (11, 7))
            with caplog.at_level("INFO"):
                server.push_text_field("ab", counter=7, start=2, end=2)
                await eventually(lambda: len(fields) == 2)
                await adapter.send_text("c")
            await eventually(lambda: len(server.ime_batches) == 1)
        finally:
            await adapter.disconnect()
    batch = server.ime_batches[0].remote_ime_batch_edit
    assert (batch.ime_counter, batch.field_counter) == (11, 7)
    assert "ime_origem=herdado" in caplog.text


async def test_library_debug_does_not_expose_an_echo_value_when_value_debugging_is_disabled(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    loggers = [logging.getLogger("androidtvremote2")]
    loggers.extend(
        candidate
        for name, candidate in logging.Logger.manager.loggerDict.items()
        if name.startswith("androidtvremote2.") and isinstance(candidate, logging.Logger)
    )
    levels = {logger: logger.level for logger in loggers}
    try:
        for logger in loggers:
            logger.setLevel(logging.DEBUG)
        fields: list[TextFieldStatus] = []
        async with FakeTvServer(tmp_path) as server:
            adapter = make_adapter(tmp_path, server.port)
            adapter.on_text_field(fields.append)
            await adapter.connect()
            try:
                with caplog.at_level(logging.DEBUG):
                    server.push_text_field("segredo de teste", counter=4, app_counter=9)
                    await eventually(lambda: bool(fields))
            finally:
                await adapter.disconnect()
        assert "segredo de teste" not in caplog.text
    finally:
        for logger, level in levels.items():
            logger.setLevel(level)


def test_value_debugging_keeps_the_library_logger_level(tmp_path: Path) -> None:
    logger = logging.getLogger("androidtvremote2")
    previous_level = logger.level
    try:
        logger.setLevel(logging.DEBUG)
        AndroidTvRemoteV2("10.0.0.4", "UniOver", tmp_path, text_debug_values=True)
        assert logger.level == logging.DEBUG
    finally:
        logger.setLevel(previous_level)


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
        self._remote_message_protocol = FakeProtocol(self)

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


class FakeProtocol:
    """Parte privada da biblioteca que o adaptador acessa para montar o lote IME."""

    def __init__(self, library: FakeLibrary) -> None:
        self._library = library
        self.ime_counter = 0
        self.ime_field_counter = 0
        self.idle_resets = 0
        self.messages: list[RemoteMessage] = []
        self._handle_message: Callable[[bytes], None] = lambda raw: None

    def _send_message(self, message: RemoteMessage, should_debug_log: bool = True) -> None:
        del should_debug_log
        if self._library.send_error is not None:
            raise self._library.send_error
        copied = RemoteMessage()
        copied.CopyFrom(message)
        self.messages.append(copied)

    def _reset_idle_disconnect_task(self) -> None:
        self.idle_resets += 1


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


# --- estado do campo de texto (gancho no tratador de mensagens da biblioteca) -------------------


async def test_the_text_field_state_the_tv_pushes_reaches_the_caller(tmp_path: Path) -> None:
    fields: list[TextFieldStatus] = []
    apps: list[str] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_text_field(fields.append)
        adapter.on_app(apps.append)
        await adapter.connect()
        try:
            await eventually(lambda: bool(apps))
            # Só o app em foco chegou até aqui: não é campo de texto, e o tratador da biblioteca
            # continua recebendo as mensagens (o app foi lido).
            assert fields == []
            server.push_text_field(
                "Matrix", counter=7, label="Buscar", start=6, end=6, app_counter=12
            )
            await eventually(lambda: bool(fields))
        finally:
            await adapter.disconnect()
    assert fields == [TextFieldStatus("Matrix", 6, 6, "Buscar", 7, 12)]


async def test_the_keyboard_request_also_carries_the_text_field_state(tmp_path: Path) -> None:
    fields: list[TextFieldStatus] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_text_field(fields.append)
        await adapter.connect()
        try:
            server.push_text_field("", counter=3, label="Pesquisar", show_request=True)
            await eventually(lambda: bool(fields))
        finally:
            await adapter.disconnect()
    assert fields == [TextFieldStatus("", 0, 0, "Pesquisar", 3)]


async def test_text_echo_logs_only_metadata_unless_value_debugging_is_enabled(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            with caplog.at_level("INFO"):
                server.push_text_field(
                    "segredo de teste", counter=4, start=16, end=16, app_counter=9
                )
                await eventually(lambda: "tv ime eco" in caplog.text)
        finally:
            await adapter.disconnect()
    assert "tv ime eco app=9 campo=4 tam=16 cursor=16-16" in caplog.text
    assert "segredo de teste" not in caplog.text


async def test_text_echo_can_log_its_value_only_when_enabled(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port, text_debug_values=True)
        await adapter.connect()
        try:
            with caplog.at_level("INFO"):
                server.push_text_field("teste acompanhado", counter=4, app_counter=9)
                await eventually(lambda: "valor='teste acompanhado'" in caplog.text)
        finally:
            await adapter.disconnect()
    assert "valor='teste acompanhado'" in caplog.text


async def test_the_real_library_still_exposes_the_private_ime_api_the_adapter_uses(
    tmp_path: Path,
) -> None:
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        await adapter.connect()
        try:
            protocol = adapter._client._remote_message_protocol
            assert callable(protocol._send_message)
            assert isinstance(protocol.ime_counter, int)
            assert isinstance(protocol.ime_field_counter, int)
        finally:
            await adapter.disconnect()


def test_the_hook_logs_a_batch_the_tv_sends_without_exposing_edit_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    handled: list[bytes] = []
    protocol = types.SimpleNamespace(_handle_message=handled.append)
    client = types.SimpleNamespace(_remote_message_protocol=protocol)
    message = RemoteMessage()
    message.remote_ime_batch_edit.ime_counter = 7
    message.remote_ime_batch_edit.field_counter = 11
    message.remote_ime_batch_edit.edit_info.add().text_field_status.value = "segredo de teste"
    assert _install_text_field_hook(client, lambda field: None) is True
    with caplog.at_level("INFO"):
        protocol._handle_message(message.SerializeToString())
    assert handled == [message.SerializeToString()]
    assert "tv ime lote da TV ime=7 campo=11" in caplog.text
    assert "segredo de teste" not in caplog.text


async def test_a_failing_listener_does_not_break_the_librarys_own_handling(tmp_path: Path) -> None:
    apps: list[str] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)

        def explode(field: TextFieldStatus) -> None:
            raise RuntimeError("ouvinte quebrado")

        adapter.on_text_field(explode)
        adapter.on_app(apps.append)
        await adapter.connect()
        try:
            server.push_text_field("a")
            server.push_volume(40)
            await eventually(lambda: apps == ["com.exemplo.video"])
            assert adapter.connected
        finally:
            await adapter.disconnect()


def test_the_hook_reports_when_the_librarys_internals_moved() -> None:
    """Se a biblioteca mudar o nome do tratador, o agente segue sem o estado (e avisa no log)."""
    assert _install_text_field_hook(object(), lambda field: None) is False
    assert _install_text_field_hook(
        types.SimpleNamespace(_remote_message_protocol=None), print
    ) is (False)


def test_the_hook_ignores_garbage_and_still_calls_the_original_handler() -> None:
    handled: list[bytes] = []
    seen: list[TextFieldStatus] = []
    protocol = types.SimpleNamespace(_handle_message=handled.append)
    client = types.SimpleNamespace(_remote_message_protocol=protocol)
    assert _install_text_field_hook(client, seen.append) is True
    protocol._handle_message(b"\xff\xff\xff not protobuf")
    message = RemoteMessage()
    message.remote_ime_key_inject.text_field_status.value = "ok"
    protocol._handle_message(message.SerializeToString())
    assert [field.value for field in seen] == ["ok"]
    assert len(handled) == 2


async def test_the_field_state_arrives_after_the_app_change_the_same_message_carries(
    tmp_path: Path,
) -> None:
    seen: list[str] = []
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        adapter.on_app(lambda app: seen.append(f"app:{app}"))
        adapter.on_text_field(lambda field: seen.append(f"campo:{field.value}"))
        await adapter.connect()
        try:
            await eventually(lambda: "app:com.exemplo.video" in seen)
            server.push_text_field("oi", app="com.exemplo.musica")
            await eventually(lambda: "campo:oi" in seen)
        finally:
            await adapter.disconnect()
    # Quem esquece o campo ao trocar de app não apaga o estado que chega junto com a troca.
    assert seen[-2:] == ["app:com.exemplo.musica", "campo:oi"]


def test_a_protocol_that_refuses_the_hook_leaves_the_adapter_connected_without_it() -> None:
    class ReadOnly:
        @property
        def _handle_message(self) -> Callable[[bytes], None]:
            return lambda raw: None

    class Slotted:
        __slots__ = ()

        def _handle_message(self, raw: bytes) -> None: ...

    for protocol in (ReadOnly(), Slotted()):
        client = types.SimpleNamespace(_remote_message_protocol=protocol)
        assert _install_text_field_hook(client, lambda field: None) is False


async def test_a_hook_that_cannot_be_installed_does_not_stop_the_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from uniover_agent.adapters import tv_remote_v2  # noqa: PLC0415

    monkeypatch.setattr(
        tv_remote_v2, "_install_text_field_hook", lambda client, callback, on_batch=None: False
    )
    async with FakeTvServer(tmp_path) as server:
        adapter = make_adapter(tmp_path, server.port)
        with caplog.at_level("WARNING"):
            await adapter.connect()
        try:
            assert adapter.connected
        finally:
            await adapter.disconnect()
    assert "sigo sem ela" in caplog.text
