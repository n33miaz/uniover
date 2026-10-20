"""Apoio dos testes do canal ADB: amostras reais da TV e um `adb` falso (sem processo real)."""

import asyncio
from collections.abc import Callable, Sequence
from pathlib import Path

from uniover_agent.adapters.tv_adb_parsing import AdbOutput

HOST = "192.168.1.6"
SERIAL = f"{HOST}:5555"
ADB = Path("adb-falso")

# Linhas de ruído que a TV imprime antes da resposta (medidas na TCL real).
NOISE = "Init wrapper sys mutex successful...\r\nopen mma dev failed\r\n"

# `cmd package query-activities --brief ... LEANBACK_LAUNCHER`, como a TCL devolve (CRLF).
LEANBACK_SAMPLE = (
    "7 activities found:\r\n"
    "  Activity #0:\r\n"
    "    priority=3 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\r\n"
    "    com.android.tv.settings/.MainSettings\r\n"
    "  Activity #1:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\n"
    "    com.android.vending/com.google.android.finsky.tvmainactivity.TvMainActivity\r\n"
    "  Activity #2:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\n"
    "    com.google.android.youtube.tv/"
    "com.google.android.apps.youtube.tv.activity.ShellActivity\r\n"
    "  Activity #3:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\n"
    "    com.tcl.suspension/.ui.main.MainActivity\r\n"
    "  Activity #4:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\r\n"
    "    com.tcl.partnercustomizer/.tkey.WithIcon\r\n"
    "  Activity #5:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\r\n"
    "    com.cnvs.apptv/.ui.LoginActivity\r\n"
    "  Activity #6:\r\n"
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\r\n"
    "    com.spotify.tv.android/.SpotifyTVActivity\r\n"
)

# `pm list packages -3` na TCL real: só o que o dono instalou.
THIRD_PARTY_SAMPLE = "package:com.spotify.tv.android\r\npackage:com.cnvs.apptv\r\n"

NO_ACTIVITIES = "0 activities found:\r\n"

QUERY_PREFIX = "cmd package query-activities --brief -a android.intent.action.MAIN -c "
LEANBACK_QUERY = QUERY_PREFIX + "android.intent.category.LEANBACK_LAUNCHER"
LAUNCHER_QUERY = QUERY_PREFIX + "android.intent.category.LAUNCHER"
PM_THIRD_PARTY = "pm list packages -3"


def shell(command: str) -> tuple[str, ...]:
    """O `argv` (sem o executável) de um comando no shell da TV."""
    return ("-s", SERIAL, "shell", command)


CONNECT = ("connect", SERIAL)
GET_STATE = ("-s", SERIAL, "get-state")
DISCONNECT = ("disconnect", SERIAL)

Reply = AdbOutput | BaseException | Callable[[], AdbOutput]


def ok(text: str, returncode: int = 0) -> AdbOutput:
    return AdbOutput(returncode, text)


class FakeAdbRunner:
    """Processo falso: responde por `argv` (sem o executável), registra e confere cada chamada.

    `script` mapeia o `argv` para uma resposta fixa ou uma lista consumida em ordem; `BaseException`
    é levantada. `argv` sem resposta é falha do teste.
    """

    def __init__(self, script: dict[tuple[str, ...], Reply | list[Reply]] | None = None) -> None:
        self.script = dict(script or {})
        self.calls: list[tuple[str, ...]] = []
        self.executables: set[str] = set()
        self.running = 0
        self.max_running = 0
        self.delay = 0.0

    def connected(self) -> None:
        """Roteiro de uma TV autorizada e acessível."""
        self.script[CONNECT] = ok(f"connected to {SERIAL}\r\n")
        self.script[GET_STATE] = ok("device\r\n")
        self.script[DISCONNECT] = ok(f"disconnected {SERIAL}\r\n")

    async def __call__(self, argv: Sequence[str], seconds: float) -> AdbOutput:
        self.executables.add(argv[0])
        key = tuple(argv[1:])
        self.calls.append(key)
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        try:
            await asyncio.sleep(self.delay)
            reply = self.script.get(key)
            if reply is None:
                raise AssertionError(f"comando adb sem resposta no teste: {key}")
            if isinstance(reply, list):
                reply = reply.pop(0) if len(reply) > 1 else reply[0]
            if isinstance(reply, BaseException):
                raise reply
            return reply() if callable(reply) else reply
        finally:
            self.running -= 1

    def shell_commands(self) -> list[str]:
        return [call[3] for call in self.calls if len(call) == 4 and call[2] == "shell"]
