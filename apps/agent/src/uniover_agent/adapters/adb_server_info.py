"""O servidor do `adb` em execução: de quando ele é, sem falar com ele.

O servidor do `adb` carrega a chave (`~/.android/adbkey`) ao subir. Se o arquivo mudou depois
disso (o Android Studio, uma cópia de volta), o servidor assina com a chave **velha** que ainda tem
em memória, e a sonda silenciosa (que lê o arquivo) provaria uma chave enquanto o `adb connect`
ofereceria outra. Esta peça só diz quando o servidor nasceu; nunca abre nem cria um servidor.

Só leitura: `netstat` para achar quem escuta a porta do servidor e `GetProcessTimes` para a hora.
"""

import asyncio
import os
import re
import sys
from typing import Final

from uniover_agent.adapters.process import exec_hidden
from uniover_agent.adapters.windows_scheduling import process_started_at

DEFAULT_SERVER_PORT: Final = 5037
_MAX_PORT: Final = 65535
_NETSTAT_SECONDS: Final = 5.0
_LISTENING: Final = re.compile(r"^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$", re.MULTILINE)


def server_port(environ: dict[str, str] | None = None) -> int:
    """A porta do servidor do `adb` (a variável `ANDROID_ADB_SERVER_PORT`, ou 5037)."""
    value = (os.environ if environ is None else environ).get("ANDROID_ADB_SERVER_PORT", "")
    return int(value) if value.isdecimal() and 0 < int(value) <= _MAX_PORT else DEFAULT_SERVER_PORT


async def adb_server_started_at(port: int | None = None) -> float | None:
    """A hora (segundos desde 1970) em que o servidor do `adb` nasceu; `None` se nenhum roda.

    Levanta `OSError` quando há servidor mas não se sabe de quando (sem Windows, `netstat` que
    falha, processo que não abre): quem usa trata isso como "não confere" e não conecta.
    """
    if sys.platform != "win32":
        raise OSError("só o Windows informa de quando o servidor do adb é")
    wanted = server_port() if port is None else port
    process = await exec_hidden(
        "netstat",
        "-ano",
        "-p",
        "tcp",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), _NETSTAT_SECONDS)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await asyncio.shield(process.wait())
        raise
    if process.returncode != 0:
        raise OSError("o netstat não respondeu")
    pids = [
        int(pid)
        for listening, pid in _LISTENING.findall(stdout.decode("utf-8", errors="replace"))
        if int(listening) == wanted
    ]
    if not pids:
        return None
    started = [process_started_at(pid) for pid in pids]
    if any(moment is None for moment in started):
        raise OSError("não deu para ler a hora do servidor do adb")
    # Mais de um dono da porta (não deveria): vale o mais antigo, que é o caso mais restritivo.
    return min(moment for moment in started if moment is not None)
