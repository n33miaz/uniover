"""Ciclo de vida da medição junto ao canal existente, com dois pares falsos."""

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from uniover_agent.adapters.pc_screen_process import (
    ScreenProcess,
    ScreenWorkerError,
    ScreenWorkerInitError,
    ScreenWorkerRefusedError,
    ScreenWorkerSyntaxError,
)
from uniover_agent.composition import pc as pc_composition
from uniover_agent.core.pc.devices import DeviceDecision
from uniover_agent.core.pc.direct import DirectRefused, DirectSettings

from .test_pc_direct import SESSION, Lab, _Approvals, settle

_DEVICE = "iphone-da-casa"
_SCREEN = "sessao-tela"


class FakeScreen:
    def __init__(self) -> None:
        self.offers: list[tuple[str, str, int, int]] = []
        self.stopped = asyncio.Event()

    async def accept_offer(self, sdp: str, token: str, ttl: int, lifetime: int) -> str:
        self.offers.append((sdp, token, ttl, lifetime))
        return "ANSWER-SCREEN"

    def stop(self) -> None:
        self.stopped.set()

    async def wait(self) -> None:
        await self.stopped.wait()


@pytest.fixture
async def measurement() -> AsyncIterator[tuple[Lab, FakeScreen]]:
    screen = FakeScreen()
    lab = Lab(screen_factory=lambda: screen)
    lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]
    try:
        yield lab, screen
    finally:
        await lab.aclose()


async def offer(lab: Lab, parent: str = SESSION, device: str | None = _DEVICE) -> str:
    return await lab.service.open(
        _SCREEN,
        "OFFER-SCREEN",
        "TOKEN-SCREEN",
        15,
        900,
        scopes=["screen"],
        parent_session_id=parent,
        device_id=device,
    )


async def test_measurement_requires_live_authenticated_parent_and_same_device(
    measurement: tuple[Lab, FakeScreen],
) -> None:
    lab, screen = measurement
    with pytest.raises(DirectRefused):
        await offer(lab)
    await lab.open(device_id=_DEVICE)
    with pytest.raises(DirectRefused):
        await offer(lab)
    await lab.open_authenticated(session="novo-pc", device_id=_DEVICE, clock=False)
    with pytest.raises(DirectRefused):
        await offer(lab)
    with pytest.raises(DirectRefused):
        await offer(lab, parent="novo-pc", device="outro-iphone")
    with pytest.raises(DirectRefused):
        await offer(lab, parent="novo-pc", device=None)
    assert screen.offers == []


@pytest.mark.parametrize("close_trigger", ["screen", "parent", "api"])
async def test_measurement_is_a_second_peer_and_follows_parent_lifetime(
    measurement: tuple[Lab, FakeScreen], close_trigger: str
) -> None:
    lab, screen = measurement
    parent = await lab.open_authenticated(device_id=_DEVICE, clock=False)
    assert await offer(lab) == "ANSWER-SCREEN"
    assert screen.offers == [("OFFER-SCREEN", "TOKEN-SCREEN", 15, 90)]
    assert lab.peer is parent and lab.service.authenticated
    with pytest.raises(DirectRefused):
        await offer(lab)
    if close_trigger == "api":
        lab.service.api_disconnected()
    else:
        await lab.service.close(SESSION if close_trigger == "parent" else _SCREEN)
    assert screen.stopped.is_set()
    assert lab.service.authenticated == (close_trigger != "parent")


async def test_measurement_exit_notifies_signaling_without_ending_control(
    measurement: tuple[Lab, FakeScreen],
) -> None:
    lab, screen = measurement
    await lab.open_authenticated(device_id=_DEVICE, clock=False)
    await offer(lab)
    screen.stopped.set()
    await settle()
    assert lab.closed == [(_SCREEN, "requested")]
    assert lab.service.authenticated
    with pytest.raises(DirectRefused):
        await offer(lab)


class FakeStream:
    def __init__(self, lines: list[bytes] | None = None) -> None:
        self._lines = list(lines or [])
        self._eof = False

    async def readline(self) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        self._eof = True
        return b""

    def at_eof(self) -> bool:
        return self._eof and len(self._lines) == 0


class FakeStdin:
    def __init__(self) -> None:
        self.written: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written.append(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class FakeSubprocess:
    def __init__(
        self,
        stdout_lines: list[bytes] | None = None,
        stderr_lines: list[bytes] | None = None,
        returncode: int | None = 0,
        pid: int = 99999,
    ) -> None:
        self.stdin = FakeStdin()
        self.stdout = FakeStream(stdout_lines)
        self.stderr = asyncio.StreamReader()
        for line in stderr_lines or []:
            self.stderr.feed_data(line)
        self.stderr.feed_eof()
        self.returncode = returncode
        self.pid = pid
        self.terminated = False

    async def wait(self) -> int:
        assert self.returncode is not None
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        if self.returncode is None:
            self.returncode = -1


async def test_screen_process_raises_syntax_error_and_records_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[b'{"error": "SDP com formato invalido", "code": "sdp_syntax"}\n']
    )

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))
    with pytest.raises(ScreenWorkerSyntaxError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "sdp_syntax"
    assert records == [("pc.screen_error", "warn", "ScreenWorkerError: sdp_syntax")]


async def test_screen_process_raises_refused_error_on_invalid_offer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[b'{"error": "Oferta recusada pelo worker", "code": "invalid_offer"}\n']
    )

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))
    with pytest.raises(ScreenWorkerRefusedError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "invalid_offer"
    assert records == [("pc.screen_error", "warn", "ScreenWorkerError: invalid_offer")]


async def test_screen_process_reports_unknown_on_premature_exit_with_stderr(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[],
        stderr_lines=[b"ImportError: texto reservado\n"],
        returncode=1,
    )

    async def fake_exec(*_args: Any, **kwargs: Any) -> FakeSubprocess:
        assert kwargs["stderr"] == asyncio.subprocess.DEVNULL
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))
    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "unknown"
    assert records == [("pc.screen_error", "warn", "ScreenWorkerError: unknown")]
    assert caplog.records[-1].__dict__["worker_diagnostic"] == {"code": "unknown"}
    assert "texto reservado" not in caplog.text


async def test_screen_process_raises_init_error_on_structured_dpi_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_proc = FakeSubprocess(
        stdout_lines=[b'{"error": "Falha de DPI", "code": "dpi_failed"}\n'],
        returncode=1,
    )

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess()
    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "dpi_failed"


async def test_screen_process_filters_unknown_code_and_invalid_metadata(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[
            b'{"error":"mensagem reservada","code":"bilhete reservado",'
            b'"exception_type":"mensagem reservada","file":"C:/privado/captura.py",'
            b'"line":"trecho reservado"}\n',
        ],
        returncode=1,
    )
    patch_worker_process(monkeypatch, fake_proc)
    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))

    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "unknown"
    assert records == [("pc.screen_error", "warn", "ScreenWorkerError: unknown")]
    assert caplog.records[-1].__dict__["worker_diagnostic"] == {"code": "unknown"}
    for text in ("reservad", "C:/privado/captura.py"):
        assert text not in str(exc_info.value)
        assert text not in caplog.text


async def test_screen_process_raises_syntax_error_on_malformed_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_proc = FakeSubprocess(stdout_lines=[b"resposta-invalida-sem-json\n"])

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess()
    with pytest.raises(ScreenWorkerSyntaxError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "syntax_error"


async def test_screen_process_captures_error_event_during_stream_and_raises_on_wait(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[
            b'{"sdp": "resposta-sdp"}\n',
            b'{"k":"error","code":"capture_error","error":"mensagem reservada",'
            b'"exception_type":"RuntimeError","file":"capture.py","line":"42"}\n',
        ]
    )

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))
    sdp = await process.accept_offer("sdp", "token", 10, 60)
    assert sdp == "resposta-sdp"

    await asyncio.sleep(0.02)

    with pytest.raises(ScreenWorkerError) as exc_info:
        await process.wait()

    assert exc_info.value.code == "capture_error"
    assert records == [
        (
            "pc.screen_error",
            "warn",
            "ScreenWorkerError: capture_error exception_type=RuntimeError file=capture.py line=42",
        ),
    ]
    (warning,) = caplog.records
    assert warning.levelno == logging.WARNING
    assert warning.__dict__["worker_diagnostic"] == {
        "code": "capture_error",
        "exception_type": "RuntimeError",
        "file": "capture.py",
        "line": 42,
    }
    assert warning.exc_info is None
    assert "mensagem reservada" not in caplog.text
    assert "mensagem reservada" not in str(exc_info.value)


async def test_screen_process_wait_raises_error_on_nonzero_exit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_proc = FakeSubprocess(
        stdout_lines=[b'{"sdp": "resposta-sdp"}\n'],
        stderr_lines=[b"Falha de sintaxe no modulo: SyntaxError\n"],
        returncode=2,
    )

    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )

    process = ScreenProcess()
    await process.accept_offer("sdp", "token", 10, 60)
    await asyncio.sleep(0.02)

    with pytest.raises(ScreenWorkerError) as exc_info:
        await process.wait()

    assert exc_info.value.code == "unknown"


async def test_lifecycle_handles_screen_worker_typed_error_and_preserves_parent(
    measurement: tuple[Lab, FakeScreen], monkeypatch: pytest.MonkeyPatch
) -> None:
    lab, screen = measurement
    parent = await lab.open_authenticated(device_id=_DEVICE, clock=False)

    async def failing_accept(_sdp: str, _token: str, _ttl: int, _lifetime: int) -> str:
        raise ScreenWorkerSyntaxError("Falha de sintaxe na oferta.", code="sdp_syntax")

    monkeypatch.setattr(screen, "accept_offer", failing_accept)

    with pytest.raises(DirectRefused):
        await offer(lab)

    assert lab.peer is parent and lab.service.authenticated


def patch_worker_process(monkeypatch: pytest.MonkeyPatch, fake: FakeSubprocess) -> None:
    async def fake_exec(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        return fake

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", fake_exec)
    monkeypatch.setattr(
        "uniover_agent.adapters.pc_screen_process.ScreenJob",
        lambda _pid: SimpleNamespace(close=lambda: None),
    )


@pytest.mark.parametrize("failure", ["write", "drain", "stopped"])
async def test_screen_process_reports_pipe_failure_during_offer(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(
        stdout_lines=[b'{"error":"texto reservado","code":"dpi_failed"}\n']
        if failure == "write"
        else None,
        stderr_lines=[b"DPI: texto reservado\n"],
        returncode=1,
    )
    patch_worker_process(monkeypatch, fake_proc)
    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))

    def fail_write(_data: bytes) -> None:
        raise BrokenPipeError

    async def fail_drain() -> None:
        if failure == "stopped":
            process.stop()
            raise ConnectionResetError
        raise OSError

    if failure == "write":
        monkeypatch.setattr(fake_proc.stdin, "write", fail_write)
    else:
        monkeypatch.setattr(fake_proc.stdin, "drain", fail_drain)

    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)
    await process.wait()

    assert fake_proc.terminated and fake_proc.stdin.closed
    assert "texto reservado" not in caplog.text
    if failure == "stopped":
        assert exc_info.value.code == "closed"
        assert records == []
        assert caplog.records == []
    else:
        code = "dpi_failed" if failure == "write" else "unknown"
        assert exc_info.value.code == code
        assert records == [("pc.screen_error", "warn", f"ScreenWorkerError: {code}")]


@pytest.mark.parametrize(
    ("returncode", "stopped", "code"),
    [(None, False, "init_failed"), (1, False, "unknown"), (1, True, "closed")],
)
async def test_screen_process_reports_job_attachment_failure(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    returncode: int | None,
    stopped: bool,
    code: str,
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(stderr_lines=[b"DPI: texto reservado\n"], returncode=returncode)
    patch_worker_process(monkeypatch, fake_proc)
    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))

    def fail_job(_pid: int) -> None:
        if stopped:
            process.stop()
        raise OSError

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.ScreenJob", fail_job)

    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)
    await process.wait()

    assert exc_info.value.code == code
    assert fake_proc.terminated and fake_proc.stdin.closed
    assert fake_proc.stdin.written == []
    assert "texto reservado" not in caplog.text
    assert records == (
        [] if stopped else [("pc.screen_error", "warn", f"ScreenWorkerError: {code}")]
    )
    if stopped:
        assert caplog.records == []


async def test_screen_process_stop_right_after_answer_does_not_leak_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_worker_process(monkeypatch, FakeSubprocess(stdout_lines=[b'{"sdp": "resposta-sdp"}\n']))
    process = ScreenProcess()
    await process.accept_offer("sdp", "token", 10, 60)

    # Sem ceder o laço: a leitura do stdout ainda não começou quando é cancelada.
    process.stop()
    await process.wait()


async def test_screen_process_stop_during_startup_is_not_recorded_as_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records: list[tuple[str, str, str]] = []
    fake_proc = FakeSubprocess(returncode=1)
    patch_worker_process(monkeypatch, fake_proc)
    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))

    async def stopped_while_reading() -> bytes:
        process.stop()
        return b""

    monkeypatch.setattr(fake_proc.stdout, "readline", stopped_while_reading)

    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "closed"
    assert records == []


async def test_screen_process_stop_during_spawn_is_not_recorded_as_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records: list[tuple[str, str, str]] = []
    process = ScreenProcess(record=lambda cat, lvl, msg: records.append((cat, lvl, msg)))
    fake_proc = FakeSubprocess()

    async def exec_stopped_worker(*_args: Any, **_kwargs: Any) -> FakeSubprocess:
        process.stop()
        return fake_proc

    monkeypatch.setattr("uniover_agent.adapters.pc_screen_process.exec_hidden", exec_stopped_worker)
    with pytest.raises(ScreenWorkerInitError) as exc_info:
        await process.accept_offer("sdp", "token", 10, 60)

    assert exc_info.value.code == "closed"
    assert fake_proc.terminated
    assert records == []


@pytest.mark.parametrize("trigger", ["deadline", "cancel", "disconnect", "inner_timeout"])
async def test_measurement_only_records_timeout_when_the_open_deadline_expires(
    monkeypatch: pytest.MonkeyPatch, trigger: str
) -> None:
    screen = FakeScreen()
    lab = Lab(
        settings=DirectSettings(accept_timeout_seconds=5, tick_seconds=0.005),
        screen_factory=lambda: screen,
    )
    lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]
    started = asyncio.Event()

    async def pending_accept(_sdp: str, _token: str, _ttl: int, _lifetime: int) -> str:
        started.set()
        if trigger == "inner_timeout":
            raise TimeoutError
        await screen.stopped.wait()
        return "ANSWER-SCREEN"

    monkeypatch.setattr(screen, "accept_offer", pending_accept)
    try:
        await lab.open_authenticated(device_id=_DEVICE, clock=False)
        if trigger == "deadline":
            lab.service._settings = replace(lab.service._settings, accept_timeout_seconds=0)
        task = asyncio.create_task(offer(lab))
        async with asyncio.timeout(1):
            await started.wait()
            if trigger == "cancel":
                task.cancel()
            elif trigger == "disconnect":
                lab.service.api_disconnected()
            with pytest.raises(asyncio.CancelledError if trigger == "cancel" else DirectRefused):
                await task
        assert screen.stopped.is_set()
        assert lab.records == (
            [("pc.screen_error", "warn", "ScreenWorkerError: init_timeout")]
            if trigger == "deadline"
            else []
        )
    finally:
        await lab.aclose()


async def test_measurement_tray_refusal_after_answer_reports_diagnostic_and_failed_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_proc = FakeSubprocess(
        stdout_lines=[
            b'{"sdp": "resposta-sdp"}\n',
            b'{"k": "error", "code": "tray_unavailable", "error": "Indicador indisponivel"}\n',
        ]
    )
    patch_worker_process(monkeypatch, fake_proc)
    records: list[tuple[str, str, str]] = []
    lab = Lab(
        screen_factory=lambda: ScreenProcess(
            record=lambda cat, lvl, msg: records.append((cat, lvl, msg))
        )
    )
    lab.service._devices = _Approvals(DeviceDecision.APPROVED)  # type: ignore[assignment]
    try:
        await lab.open_authenticated(device_id=_DEVICE, clock=False)
        assert await offer(lab) == "resposta-sdp"
        await settle()

        assert lab.closed == [(_SCREEN, "failed")]
        assert records == [("pc.screen_error", "warn", "ScreenWorkerError: tray_unavailable")]
        assert lab.service.authenticated
    finally:
        await lab.aclose()


async def test_measurement_failure_notifies_signaling_and_allows_a_new_offer(
    measurement: tuple[Lab, FakeScreen],
) -> None:
    lab, screen = measurement
    parent = await lab.open_authenticated(device_id=_DEVICE, clock=False)
    failed = asyncio.Event()

    async def failing_wait() -> None:
        await failed.wait()
        # Como o processo real: depois de parado, a espera não levanta mais.
        if not screen.stopped.is_set():
            raise ScreenWorkerError("Erro no fluxo de tela.", code="capture_error")

    screen.wait = failing_wait  # type: ignore[method-assign]
    await offer(lab)
    failed.set()
    await settle()

    assert screen.stopped.is_set()
    assert lab.closed == [(_SCREEN, "failed")]
    assert lab.peer is parent and lab.service.authenticated
    answer = await lab.service.open(
        "outra-sessao-tela",
        "OFFER-SCREEN",
        "TOKEN-SCREEN",
        15,
        900,
        scopes=["screen"],
        parent_session_id=SESSION,
        device_id=_DEVICE,
    )
    assert answer == "ANSWER-SCREEN"


def test_composition_gives_the_screen_process_the_diagnostic_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sys.platform", "win32")
    unused: Any = SimpleNamespace()
    settings: Any = SimpleNamespace(
        pc_direct_connect_timeout_seconds=10,
        pc_direct_idle_seconds=60,
        pc_direct_max_lifetime_seconds=900,
        pc_direct_api_grace_seconds=30,
        pc_direct_reconcile_seconds=30,
    )

    def record(_kind: str, _severity: str, _detail: str) -> None:
        pass

    service = pc_composition._build_direct(
        settings, unused, None, unused, unused, "agente", unused, None, record, unused
    )

    assert service._screen_factory is not None
    screen = service._screen_factory()
    assert isinstance(screen, ScreenProcess)
    assert screen._record is record
