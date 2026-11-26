"""Processo descartável de medição, fora do laço de entrada do PC."""

import asyncio
import contextlib
import json
import logging
import sys
from collections.abc import Callable

from uniover_agent.adapters.pc_screen_job import ScreenJob
from uniover_agent.adapters.process import exec_hidden

_log = logging.getLogger(__name__)

_BELOW_NORMAL_PRIORITY_CLASS = 0x4000
_MAX_STDERR_LINES = 50


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


class ScreenWorkerTimeoutError(ScreenWorkerError):
    """Tempo limite excedido na comunicação com o worker."""

    def __init__(
        self,
        message: str = "Tempo limite excedido no worker de tela.",
        *,
        code: str = "timeout",
    ) -> None:
        super().__init__(message, code=code)


class ScreenProcess:
    def __init__(self, record: Callable[[str, str, str], None] | None = None) -> None:
        self._record = record
        self._process: asyncio.subprocess.Process | None = None
        self._stopped = False
        self._job: ScreenJob | None = None
        self._stderr_lines: list[str] = []
        self._stderr_task: asyncio.Task[None] | None = None
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
            stderr=asyncio.subprocess.PIPE,
        )
        self._process = process
        if process.stderr is not None:
            self._stderr_task = asyncio.create_task(self._drain_stderr())
        try:
            if self._stopped or process.stdin is None or process.stdout is None:
                err: ScreenWorkerError = ScreenWorkerInitError(
                    "Medição encerrada ou canais de comunicação indisponíveis.", code="closed"
                )
                self._record_error(err)
                raise err
            self._job = ScreenJob(process.pid)
            offer = {
                "sdp": sdp,
                "token": token,
                "tokenTtlSeconds": ttl_seconds,
                "maxLifetimeSeconds": lifetime_seconds,
            }
            process.stdin.write(json.dumps(offer).encode("ascii") + b"\n")
            await process.stdin.drain()

            raw_line = await process.stdout.readline()
            if not raw_line:
                # O processo do worker encerrou sem responder nada no stdout
                await process.wait()
                if self._stopped:
                    # Parada pedida durante a abertura: não é falha e não vai ao diagnóstico.
                    raise ScreenWorkerInitError(
                        "Medição encerrada durante a inicialização.", code="closed"
                    )
                await self._finish_drains()
                code = self._classify_stderr()
                err = ScreenWorkerInitError(
                    "Processo de medição encerrou prematuramente sem resposta.",
                    code=code,
                )
                self._record_error(err)
                raise err

            try:
                answer = json.loads(raw_line)
            except (ValueError, TypeError) as exc:
                err = ScreenWorkerSyntaxError(
                    "Resposta do worker não é um JSON válido.",
                    code="syntax_error",
                )
                self._record_error(err)
                raise err from exc

            if not isinstance(answer, dict):
                err = ScreenWorkerSyntaxError(
                    "Resposta do worker não é um objeto JSON.",
                    code="syntax_error",
                )
                self._record_error(err)
                raise err

            if "error" in answer:
                error_msg = str(answer.get("error", "Erro do worker de tela."))
                error_code = str(answer.get("code", "worker_error"))
                error_cls = self._error_class_for_code(error_code)
                err = error_cls(error_msg, code=error_code)
                self._record_error(err)
                raise err

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
            raise

    def _record_error(self, error: ScreenWorkerError) -> None:
        self._last_error = error
        _log.error("erro do worker de tela: %s (código: %s)", error, error.code)
        if self._record is not None:
            # "warn": é a severidade mais alta que o registro do controle do PC preserva.
            self._record("pc.screen_error", "warn", f"ScreenWorkerError: {error.code}")

    @staticmethod
    def _error_class_for_code(code: str) -> type[ScreenWorkerError]:
        if code in {"sdp_syntax", "syntax_error"}:
            return ScreenWorkerSyntaxError
        if code in {"invalid_offer", "offer_refused"}:
            return ScreenWorkerRefusedError
        if code in {"dpi_failed", "init_failed", "premature_exit"}:
            return ScreenWorkerInitError
        if code in {"init_timeout", "timeout"}:
            return ScreenWorkerTimeoutError
        return ScreenWorkerError

    def _classify_stderr(self) -> str:
        combined = " ".join(self._stderr_lines).lower()
        if "syntaxerror" in combined or "invalid syntax" in combined:
            return "syntax_error"
        if (
            "importerror" in combined
            or "modulenotfounderror" in combined
            or "dll load failed" in combined
        ):
            return "init_failed"
        if "setprocessdpiawarenesscontext" in combined or "dpi" in combined:
            return "dpi_failed"
        if "timeout" in combined:
            return "timeout"
        if "capture" in combined:
            return "capture_error"
        return "init_failed"

    async def _drain_stderr(self) -> None:
        if self._process is None or self._process.stderr is None:
            return
        with contextlib.suppress(Exception, asyncio.CancelledError):
            while not self._process.stderr.at_eof():
                line = await self._process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    self._stderr_lines.append(text)
                    if len(self._stderr_lines) > _MAX_STDERR_LINES:
                        self._stderr_lines.pop(0)

    async def _finish_drains(self) -> None:
        """Espera a leitura das saídas acabar.

        `asyncio.wait` não repassa o cancelamento que `stop()` faz numa leitura ainda não iniciada.
        """
        drains = [task for task in (self._stdout_task, self._stderr_task) if task is not None]
        if drains:
            await asyncio.wait(drains)

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
                        code = str(data.get("code", "capture_error"))
                        msg = str(data.get("error", "Erro durante fluxo de tela."))
                        err = ScreenWorkerError(f"Erro no fluxo de tela: {msg}", code=code)
                        self._record_error(err)

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
        if self._stderr_task is not None:
            self._stderr_task.cancel()

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()
            await self._finish_drains()
            if not self._stopped:
                if self._last_error is not None:
                    raise self._last_error
                if self._process.returncode != 0:
                    code = self._classify_stderr()
                    err = ScreenWorkerError(
                        f"Processo de medição encerrou com código {self._process.returncode}.",
                        code=code,
                    )
                    self._record_error(err)
                    raise err
