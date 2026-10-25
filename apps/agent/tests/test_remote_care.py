"""Manutenção remota no agente: registro sem segredos, tamanho, sinais ao supervisor e `hello`."""

import asyncio
import json
import os
from pathlib import Path

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters.agent_log_file import FileLogSource
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTransport
from uniover_agent.adapters.maintenance_signals import RuntimeFlagSignals
from uniover_agent.config import Settings
from uniover_agent.core import (
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    ResultStatus,
    agent_logs_handler,
    agent_maintenance_handler,
)
from uniover_agent.core.envelopes import serialized_size
from uniover_agent.core.remote_care import (
    FRAME_LIMIT_BYTES,
    LOG_UNAVAILABLE,
    MAINTENANCE_UNAVAILABLE,
    SEND_FAILED,
    TEXT_LIMIT_CHARS,
    fit_excerpt,
)
from uniover_agent.main import (
    EXIT_CREDENTIAL_REJECTED,
    build_remote_care,
    build_version,
    describe_os,
    log_file_path,
    run,
)
from uniover_agent.ports import TransportError
from uniover_agent.ports.remote_care import LogUnavailable

from .support import AGENT_ID, TOKEN, FakeApi, dump, envelope

REQUEST_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"
COMMAND_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f"


class ListSource:
    def __init__(self, lines: list[str]) -> None:
        self.lines = lines
        self.asked: list[int] = []

    def tail(self, lines: int) -> list[str]:
        self.asked.append(lines)
        return self.lines[-lines:]


class BrokenSource:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def tail(self, lines: int) -> list[str]:
        raise self.error


def factory() -> EnvelopeFactory:
    return EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), FakeClock())


def logs_command(lines: int = 300, **body: object) -> Command:
    return Command(
        COMMAND_ID, "agent.logs.request.v1", {"requestId": REQUEST_ID, "lines": lines, **body}
    )


# --- ajuste ao quadro ---------------------------------------------------------------------------


def test_everything_fits_when_the_log_is_small() -> None:
    excerpt = fit_excerpt(["a", "b", "c"], 1000)
    assert (excerpt.text, excerpt.lines, excerpt.truncated) == ("a\nb\nc", 3, False)


def test_the_oldest_lines_go_first_and_the_cut_is_reported() -> None:
    lines = [f"linha {n:03d} " + "x" * 40 for n in range(100)]
    excerpt = fit_excerpt(lines, 1000)
    assert excerpt.truncated
    assert excerpt.text.splitlines() == lines[-excerpt.lines :]
    assert 0 < excerpt.lines < 100


def test_the_character_limit_of_the_schema_is_respected() -> None:
    lines = ["y" * 999] * 100
    excerpt = fit_excerpt(lines, 10_000_000)
    assert len(excerpt.text) <= TEXT_LIMIT_CHARS
    assert excerpt.truncated


def test_one_huge_line_keeps_only_its_end_with_a_mark() -> None:
    excerpt = fit_excerpt(["curta", "início-" + "z" * 5000 + "-fim"], 300)
    assert excerpt.truncated
    assert excerpt.lines == 1
    assert excerpt.text.startswith("[...] ")
    assert excerpt.text.endswith("-fim")
    assert "início" not in excerpt.text


def test_escaped_characters_count_for_their_real_size() -> None:
    # Cada aspas vira `\"` no JSON: o dobro de bytes. O orçamento tem de considerar isso.
    excerpt = fit_excerpt(['"' * 400], 500)
    assert len(json.dumps(excerpt.text, ensure_ascii=False)) - 2 <= 500


# --- manipulador do registro --------------------------------------------------------------------


async def test_the_handler_sends_the_cleaned_tail_before_returning_ok() -> None:
    transport = FakeTransport()
    source = ListSource(["início", f"Authorization: Bearer {TOKEN}", f"token={TOKEN}", "pronto"])
    handle = agent_logs_handler(source, transport, factory(), lambda: [TOKEN])

    result = await handle(logs_command(lines=3))

    assert result.status is ResultStatus.OK
    assert source.asked == [3]
    (sent,) = transport.sent
    assert sent["type"] == "agent.logs.v1"
    assert sent["correlationId"] == COMMAND_ID
    assert sent["body"]["requestId"] == REQUEST_ID
    assert sent["body"]["lines"] == 3
    assert sent["body"]["truncated"] is False
    assert TOKEN not in sent["body"]["text"]
    assert sent["body"]["text"].splitlines() == [
        "Authorization: [removido]",
        "token=[removido]",
        "pronto",
    ]


async def test_a_secret_cut_by_the_size_limit_is_still_removed() -> None:
    """O corte vem depois da higienização: o segredo não escapa por ter sido partido."""
    huge = "a" * 70_000 + f" Authorization: Bearer {TOKEN}"
    transport = FakeTransport()
    handle = agent_logs_handler(ListSource([huge]), transport, factory(), lambda: [TOKEN])

    result = await handle(logs_command(lines=1))

    assert result.status is ResultStatus.OK
    (sent,) = transport.sent
    assert TOKEN not in sent["body"]["text"]
    assert "Bearer" not in sent["body"]["text"] or "[removido]" in sent["body"]["text"]
    assert sent["body"]["truncated"] is True


async def test_the_frame_always_fits_the_transport_limit() -> None:
    lines = [f"{n} " + 'ü"\\' * 300 for n in range(1000)]
    transport = FakeTransport()
    handle = agent_logs_handler(ListSource(lines), transport, factory())

    result = await handle(logs_command(lines=1000))

    assert result.status is ResultStatus.OK
    (sent,) = transport.sent
    assert serialized_size(sent) <= FRAME_LIMIT_BYTES
    assert serialized_size(sent) < 64 * 1024
    assert sent["body"]["truncated"] is True
    assert len(sent["body"]["text"]) <= TEXT_LIMIT_CHARS


async def test_an_empty_log_is_an_empty_answer_not_a_failure() -> None:
    transport = FakeTransport()
    result = await agent_logs_handler(ListSource([]), transport, factory())(logs_command())
    assert result.status is ResultStatus.OK
    assert transport.sent[0]["body"] | {"at": ""} == {
        "requestId": REQUEST_ID,
        "text": "",
        "lines": 0,
        "truncated": False,
        "at": "",
    }


@pytest.mark.parametrize("body", [{}, {"requestId": REQUEST_ID}, {"lines": 5}])
async def test_a_request_without_its_fields_is_rejected(body: dict[str, object]) -> None:
    handle = agent_logs_handler(ListSource(["x"]), FakeTransport(), factory())
    result = await handle(Command(COMMAND_ID, "agent.logs.request.v1", body))
    assert result.status is ResultStatus.REJECTED


async def test_a_missing_log_file_answers_with_a_stable_code() -> None:
    transport = FakeTransport()
    handle = agent_logs_handler(BrokenSource(LogUnavailable("sem arquivo")), transport, factory())
    result = await handle(logs_command())
    assert (result.status, result.code) == (ResultStatus.FAILED, LOG_UNAVAILABLE)
    assert transport.sent == []


async def test_an_unexpected_read_error_never_leaks_its_text() -> None:
    handle = agent_logs_handler(
        BrokenSource(RuntimeError(f"falhou com {TOKEN}")), FakeTransport(), factory()
    )
    result = await handle(logs_command())
    assert result.code == LOG_UNAVAILABLE
    assert TOKEN not in result.detail


async def test_a_lost_connection_while_sending_is_a_failure_with_a_code() -> None:
    class Dead(FakeTransport):
        async def send(self, message: dict[str, object]) -> None:
            raise TransportError("caiu")

    result = await agent_logs_handler(ListSource(["x"]), Dead(), factory())(logs_command())
    assert (result.status, result.code) == (ResultStatus.FAILED, SEND_FAILED)


# --- arquivo de registro ------------------------------------------------------------------------


def test_the_file_source_returns_the_last_whole_lines(tmp_path: Path) -> None:
    path = tmp_path / "agent.log"
    path.write_text("\n".join(f"linha {n}" for n in range(10)) + "\n", encoding="utf-8")
    assert FileLogSource(path).tail(3) == ["linha 7", "linha 8", "linha 9"]
    assert len(FileLogSource(path).tail(1000)) == 10


def test_the_file_source_drops_the_partial_first_line_of_a_big_file(tmp_path: Path) -> None:
    path = tmp_path / "agent.log"
    path.write_text("\n".join(f"linha-{n:06d}" + "x" * 80 for n in range(20_000)), encoding="utf-8")
    lines = FileLogSource(path).tail(100_000)
    assert lines
    assert all(line.startswith("linha-") and line.endswith("x" * 80) for line in lines)
    assert lines[-1].startswith("linha-019999")
    assert len(lines) < 20_000


def test_the_file_source_survives_bytes_that_are_not_utf8(tmp_path: Path) -> None:
    path = tmp_path / "agent.log"
    path.write_bytes(b"ok\n\xff\xfe quebrado\nfim\n")
    assert FileLogSource(path).tail(10)[-1] == "fim"


def test_the_file_source_falls_back_to_the_old_location_and_then_gives_up(tmp_path: Path) -> None:
    old = tmp_path / "agent.log"
    old.write_text("antigo\n", encoding="utf-8")
    assert FileLogSource(tmp_path / "logs" / "agent.log", fallback=old).tail(5) == ["antigo"]
    with pytest.raises(LogUnavailable):
        FileLogSource(tmp_path / "nada.log", fallback=tmp_path / "nada-tambem.log").tail(5)


def test_the_log_path_comes_from_the_local_configuration_only(tmp_path: Path) -> None:
    assert log_file_path(Settings(log_file=str(tmp_path / "meu.log"))) == tmp_path / "meu.log"
    default = log_file_path(Settings())
    assert default.name == "agent.log"
    assert default.parent.name == "logs"
    assert default.is_relative_to(Path(os.environ["LOCALAPPDATA"]))


# --- manutenção ---------------------------------------------------------------------------------


class Signals:
    def __init__(self, error: Exception | None = None, *, previous: bool = True) -> None:
        self.calls: list[str] = []
        self.error = error
        self.previous = previous

    def request_rollback(self) -> None:
        if self.error:
            raise self.error
        self.calls.append("rollback")

    def previous_available(self) -> bool:
        return self.previous

    def request_update(self) -> None:
        if self.error:
            raise self.error
        self.calls.append("update")

    def request_restart(self) -> None:
        if self.error:
            raise self.error
        self.calls.append("restart")


@pytest.mark.parametrize("action", ["update", "restart", "rollback"])
async def test_the_maintenance_handler_hands_the_request_to_the_supervisor(action: str) -> None:
    signals = Signals()
    result = await agent_maintenance_handler(signals)(
        Command(COMMAND_ID, "agent.maintenance.v1", {"action": action})
    )
    assert result.status is ResultStatus.OK
    assert signals.calls == [action]


async def test_rolling_back_without_a_previous_version_is_refused_with_a_stable_code() -> None:
    signals = Signals(previous=False)
    result = await agent_maintenance_handler(signals)(
        Command(COMMAND_ID, "agent.maintenance.v1", {"action": "rollback"})
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, "no_previous_version")
    assert signals.calls == []


@pytest.mark.parametrize("body", [{}, {"action": "format"}, {"action": 1}])
async def test_an_unknown_action_does_nothing(body: dict[str, object]) -> None:
    signals = Signals()
    result = await agent_maintenance_handler(signals)(
        Command(COMMAND_ID, "agent.maintenance.v1", body)
    )
    assert result.status is ResultStatus.REJECTED
    assert signals.calls == []


async def test_a_failure_to_signal_is_reported_with_a_code_and_no_exception_text() -> None:
    signals = Signals(PermissionError(f"negado em C:\\segredo\\{TOKEN}"))
    result = await agent_maintenance_handler(signals)(
        Command(COMMAND_ID, "agent.maintenance.v1", {"action": "restart"})
    )
    assert (result.status, result.code) == (ResultStatus.FAILED, MAINTENANCE_UNAVAILABLE)
    assert TOKEN not in result.detail


def test_the_signals_are_the_same_files_the_tray_uses(tmp_path: Path) -> None:
    signals = RuntimeFlagSignals(tmp_path / "runtime")
    signals.request_update()
    signals.request_restart()
    signals.request_rollback()
    assert sorted(p.name for p in (tmp_path / "runtime").iterdir()) == [
        "restart-now",
        "rollback-now",
        "update-now",
    ]


def test_a_previous_version_counts_only_with_a_version_file_and_remote_care(
    tmp_path: Path,
) -> None:
    previous = tmp_path / "app.previous"
    signals = RuntimeFlagSignals(tmp_path / "runtime", previous)
    assert signals.previous_available() is False
    previous.mkdir()
    assert signals.previous_available() is False
    (previous / ".version").write_text("a" * 40 + "\n", encoding="utf-8")
    # Uma versão anterior sem a manutenção remota deixaria o PC sem como voltar a ser cuidado.
    assert signals.previous_available() is False
    care = previous / "src" / "uniover_agent" / "adapters"
    care.mkdir(parents=True)
    (care / "maintenance_signals.py").write_text("", encoding="utf-8")
    assert signals.previous_available() is True


def test_the_default_signal_folder_is_under_the_isolated_local_app_data() -> None:
    RuntimeFlagSignals().request_restart()
    flag = Path(os.environ["LOCALAPPDATA"]) / "UniOver" / "runtime" / "restart-now"
    assert flag.is_file()


# --- composição e `hello` -----------------------------------------------------------------------


def test_the_composition_registers_both_commands() -> None:
    care = build_remote_care(Settings(), FakeTransport(), factory(), FakeSecretStore(), AGENT_ID)
    assert set(care) == {"agent.logs.request.v1", "agent.maintenance.v1"}


def test_the_version_carries_the_installed_commit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "localappdata" / "UniOver" / "app"
    source.mkdir(parents=True)
    assert "+" not in build_version()
    (source / ".version").write_text("3f2a9c1d4e5b6a7788990011223344556677889a\n", encoding="utf-8")
    assert build_version().endswith("+3f2a9c1d4e5b")
    (source / ".version").write_text("não é um commit", encoding="utf-8")
    assert "+" not in build_version()


def test_the_os_description_is_short_and_never_empty() -> None:
    description = describe_os()
    assert description
    assert len(description) <= 80


async def test_run_announces_the_capabilities_the_system_and_the_tv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("uniover_agent.main.describe_os", lambda: "Windows 11 (10.0.26200)")

    async def script(connection: ServerConnection) -> None:
        await asyncio.sleep(0.1)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    hello = api.received[0]
    assert hello["type"] == "agent.hello.v1"
    assert {"agent.logs.v1", "agent.maintenance.v1"} <= set(hello["body"]["capabilities"])
    assert hello["body"]["os"] == "Windows 11 (10.0.26200)"
    # Sem TV configurada o `hello` nem cita a TV.
    assert "tv" not in hello["body"]


async def test_run_serves_the_log_over_the_real_channel_without_secrets(tmp_path: Path) -> None:
    log = tmp_path / "meu-registro.log"
    log.write_text(
        "2026-10-24 14:00:00 INFO conectado\n"
        f"2026-10-24 14:00:01 DEBUG Authorization: Bearer {TOKEN}\n",
        encoding="utf-8",
    )

    async def script(connection: ServerConnection) -> None:
        await connection.send(
            dump(
                envelope(
                    "agent.logs.request.v1", {"requestId": REQUEST_ID, "lines": 50}, id=COMMAND_ID
                )
            )
        )
        await asyncio.sleep(0.5)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, log_file=str(log)
        )
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    types = [m["type"] for m in api.received]
    # O quadro do registro sai antes do resultado do comando.
    assert types.index("agent.logs.v1") < types.index("command.result.v1")
    sent = next(m for m in api.received if m["type"] == "agent.logs.v1")
    assert sent["correlationId"] == COMMAND_ID
    assert sent["body"]["requestId"] == REQUEST_ID
    assert TOKEN not in json.dumps(sent)
    assert "conectado" in sent["body"]["text"]
    result = next(m for m in api.received if m["type"] == "command.result.v1")
    assert result["body"] == {"ok": True}
    assert result["correlationId"] == COMMAND_ID


async def test_run_turns_a_remote_restart_into_the_supervisor_flag() -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.send(
            dump(envelope("agent.maintenance.v1", {"action": "restart"}, id=COMMAND_ID))
        )
        await asyncio.sleep(0.5)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True)
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    result = next(m for m in api.received if m["type"] == "command.result.v1")
    assert result["body"] == {"ok": True}
    flag = Path(os.environ["LOCALAPPDATA"]) / "UniOver" / "runtime" / "restart-now"
    assert flag.is_file()
    # Nada de sair do processo: a conexão só terminou porque o servidor falso a fechou.
    assert not (flag.parent / "update-now").exists()
