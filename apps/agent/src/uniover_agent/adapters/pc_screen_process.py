"""Processo descartável de medição, fora do laço de entrada do PC."""

import asyncio
import contextlib
import json
import logging
import re
import sys
from collections.abc import Callable

from uniover_agent.adapters.pc_screen_job import ScreenJob
from uniover_agent.adapters.process import exec_hidden

_log = logging.getLogger(__name__)

_BELOW_NORMAL_PRIORITY_CLASS = 0x4000
_KNOWN_WORKER_CODES = {
    "capture_error",
    "dpi_failed",
    "init_failed",
    "invalid_offer",
    "offer_refused",
    "premature_exit",
    "sdp_failed",
    "sdp_syntax",
    "syntax_error",
    "timeout",
    "tray_unavailable",
    "worker_error",
}


class ScreenWorkerError(RuntimeError):
    """Erro tipado emitido pelo worker de tela ou durante sua execução."""

    def __init__(self, message: str, *, code: str = "worker_error") -> None:
        super().__init__(message)
        self.code = code


class ScreenWorkerInitError(ScreenWorkerError):
    """Falha durante a inicialização do worker ou encerramento prematuro."""

    def __init__(
        self,
        message: str = "Falha de inicialização do worker de tela.",
        *,
        code: str = "init_failed",
    ) -> None:
        super().__init__(message, code=code)


class ScreenWorkerSyntaxError(ScreenWorkerError):
    """Falha de sintaxe na oferta ou no SDP informado."""

    def __init__(
        self,
        message: str = "Falha de sintaxe na oferta ou SDP.",
        *,
        code: str = "syntax_error",
    ) -> None:
        super().__init__(message, code=code)


class ScreenWorkerRefusedError(ScreenWorkerError):
    """Oferta de tela recusada pelo worker."""

    def __init__(
        self,
        message: str = "Oferta de tela recusada pelo worker.",
        *,
        code: str = "offer_refused",
    ) -> None:
        super().__init__(message, code=code)


class ScreenProcess:
    def __init__(self, record: Callable[[str, str, str], None] | None = None) -> None:
        self._record = record
        self._process: asyncio.subprocess.Process | None = None
        self._stopped = False
        self._job: ScreenJob | None = None
        self._stdout_task: asyncio.Task[None] | None = None
        self._last_error: ScreenWorkerError | None = None

    async def accept_offer(
        self, sdp: str, token: str, ttl_seconds: int, lifetime_seconds: int
    ) -> str:
        process = await exec_hidden(
            sys.executable,
            "-B",
            "-m",
            "uniover_agent.adapters.pc_screen_worker",
            creationflags=_BELOW_NORMAL_PRIORITY_CLASS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._process = process
        try:
            if self._stopped or process.stdin is None or process.stdout is None:
                err: ScreenWorkerError = ScreenWorkerInitError(
                    "Medição encerrada ou canais de comunicação indisponíveis.", code="closed"
                )
                if not self._stopped:
                    self._record_error(err)
                raise err
            await self._attach_job(process)
            offer = {
                "sdp": sdp,
                "token": token,
                "tokenTtlSeconds": ttl_seconds,
                "maxLifetimeSeconds": lifetime_seconds,
            }
            try:
                process.stdin.write(json.dumps(offer).encode("ascii") + b"\n")
                await process.stdin.drain()
            except OSError:
                raise await self._premature_exit(process, read_diagnostic=True) from None

            raw_line = await process.stdout.readline()
            if not raw_line:
                raise await self._premature_exit(process)

            try:
                answer = json.loads(raw_line)
            except ValueError, TypeError:
                err = ScreenWorkerSyntaxError(
                    "Resposta do worker não é um JSON válido.",
                    code="syntax_error",
                )
                self._record_error(err)
                raise err from None

            if not isinstance(answer, dict):
                err = ScreenWorkerSyntaxError(
                    "Resposta do worker não é um objeto JSON.",
                    code="syntax_error",
                )
                self._record_error(err)
                raise err

            if "error" in answer:
                raise self._report_worker_error(answer, startup=True)

            answer_sdp = answer.get("sdp")
            if not isinstance(answer_sdp, str) or not answer_sdp:
                err = ScreenWorkerSyntaxError(
                    "Processo de medição não respondeu com SDP válido.",
                    code="sdp_syntax",
                )
                self._record_error(err)
                raise err

            # Lê o stdout em segundo plano para capturar erros emitidos após o aperto de mão
            self._stdout_task = asyncio.create_task(self._drain_stdout())
            return answer_sdp
        except Exception, asyncio.CancelledError:
            self.stop()
            await process.wait()
            await self._finish_stdout()
            raise

    async def _attach_job(self, process: asyncio.subprocess.Process) -> None:
        try:
            self._job = ScreenJob(process.pid)
        except OSError as exc:
            if self._stopped or process.returncode is not None:
                raise await self._premature_exit(process, read_diagnostic=True) from None
            error = ScreenWorkerInitError("Não foi possível vincular o worker de tela ao job.")
            self._record_error(error)
            raise error from exc

    async def _premature_exit(
        self, process: asyncio.subprocess.Process, *, read_diagnostic: bool = False
    ) -> ScreenWorkerError:
        answer = None
        if read_diagnostic and not self._stopped and process.stdout is not None:
            # O worker pode já ter escrito o diagnóstico quando o canal de entrada falhou.
            with contextlib.suppress(OSError, ValueError):
                answer = json.loads(await process.stdout.readline())
        await process.wait()
        if self._stopped:
            return ScreenWorkerInitError(
                "Medição encerrada durante a inicialização.", code="closed"
            )
        if isinstance(answer, dict) and "error" in answer:
            return self._report_worker_error(answer, startup=True)
        error = ScreenWorkerInitError(
            "Processo de medição encerrou prematuramente sem resposta.",
            code="unknown",
        )
        self._record_error(error)
        return error

    def _record_error(
        self, error: ScreenWorkerError, metadata: dict[str, str | int] | None = None
    ) -> None:
        self._last_error = error
        diagnostic = {"code": error.code, **(metadata or {})}
        _log.warning(
            "falha no worker de tela: %s", diagnostic, extra={"worker_diagnostic": diagnostic}
        )
        if self._record is not None:
            # "warn": é a severidade mais alta que o registro do controle do PC preserva.
            fields = "".join(f" {key}={value}" for key, value in (metadata or {}).items())
            self._record("pc.screen_error", "warn", f"ScreenWorkerError: {error.code}{fields}")

    @staticmethod
    def _error_class_for_code(code: str) -> type[ScreenWorkerError]:
        if code in {"sdp_syntax", "syntax_error"}:
            return ScreenWorkerSyntaxError
        if code in {"invalid_offer", "offer_refused"}:
            return ScreenWorkerRefusedError
        if code in {"dpi_failed", "init_failed", "premature_exit", "unknown"}:
            return ScreenWorkerInitError
        return ScreenWorkerError

    def _report_worker_error(self, data: dict[str, object], *, startup: bool) -> ScreenWorkerError:
        raw_code = data.get("code")
        code = "unknown"
        if isinstance(raw_code, str) and raw_code in _KNOWN_WORKER_CODES:
            code = raw_code
        error_cls = self._error_class_for_code(code) if startup else ScreenWorkerError
        error = error_cls("Falha no worker de tela.", code=code)
        metadata: dict[str, str | int] = {}
        exception_type, file, line = data.get("exception_type"), data.get("file"), data.get("line")
        if isinstance(exception_type, str) and re.fullmatch(
            r"[A-Za-z_][A-Za-z0-9_]{0,127}", exception_type
        ):
            metadata["exception_type"] = exception_type
        if isinstance(file, str) and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", file):
            metadata["file"] = file
        if isinstance(line, str) and re.fullmatch(r"[1-9][0-9]{0,8}", line):
            metadata["line"] = int(line)
        self._record_error(error, metadata)
        return error

    async def _finish_stdout(self) -> None:
        if self._stdout_task is not None:
            # `asyncio.wait` não repassa o cancelamento de uma leitura ainda não iniciada.
            await asyncio.wait([self._stdout_task])

    async def _drain_stdout(self) -> None:
        if self._process is None or self._process.stdout is None:
            return
        with contextlib.suppress(Exception, asyncio.CancelledError):
            while not self._process.stdout.at_eof():
                line = await self._process.stdout.readline()
                if not line:
                    break
                with contextlib.suppress(ValueError, TypeError):
                    data = json.loads(line)
                    if isinstance(data, dict) and data.get("k") == "error":
                        self._report_worker_error(data, startup=False)

    def stop(self) -> None:
        self._stopped = True
        if self._job is not None:
            self._job.close()
            self._job = None
        process = self._process
        if process is not None:
            if process.stdin is not None:
                process.stdin.close()
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        if self._stdout_task is not None:
            self._stdout_task.cancel()

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()
            await self._finish_stdout()
            if not self._stopped:
                if self._last_error is not None:
                    raise self._last_error
                if self._process.returncode != 0:
                    err = ScreenWorkerError(
                        f"Processo de medição encerrou com código {self._process.returncode}.",
                        code="unknown",
                    )
                    self._record_error(err)
                    raise err
