"""Processo descartável de medição, fora do laço de entrada do PC."""

import asyncio
import contextlib
import json
import sys

from uniover_agent.adapters.pc_screen_job import ScreenJob
from uniover_agent.adapters.process import exec_hidden

_BELOW_NORMAL_PRIORITY_CLASS = 0x4000


class ScreenProcess:
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._stopped = False
        self._job: ScreenJob | None = None

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
                raise RuntimeError("medição encerrada")
            self._job = ScreenJob(process.pid)
            offer = {
                "sdp": sdp,
                "token": token,
                "tokenTtlSeconds": ttl_seconds,
                "maxLifetimeSeconds": lifetime_seconds,
            }
            process.stdin.write(json.dumps(offer).encode("ascii") + b"\n")
            await process.stdin.drain()
            answer = json.loads(await process.stdout.readline())
            if not isinstance(answer, dict) or not isinstance(answer.get("sdp"), str):
                raise RuntimeError("processo de medição não respondeu")
            return answer["sdp"]
        except Exception, asyncio.CancelledError:
            self.stop()
            await process.wait()
            raise

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

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()
