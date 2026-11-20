"""O que o Windows diz estar tocando: a sessão de mídia do sistema
(`GlobalSystemMediaTransportControls`).

Nenhuma biblioteca a mais: um `powershell.exe` do sistema, com um script fixo de SÓ LEITURA (nada
vindo da rede entra nele), lê a sessão atual e devolve um JSON em base64 (o título pode ter
acento, e a página de código do console o estragaria). Uma leitura custa uns 300 ms e só acontece
quando o app pede, nunca em
laço. O título e o artista nunca vão para o registro.

O executor do script fica atrás de `Runner`: os testes entregam a saída pronta e nunca iniciam o
PowerShell. Fora do Windows tudo recusa com `PcUnsupported`.
"""

import base64
import json
import os
import sys
from collections.abc import Callable
from typing import Final

from uniover_agent.adapters.process import run_hidden
from uniover_agent.ports.pc import PcUnsupported
from uniover_agent.ports.pc_media import (
    MAX_MEDIA_TEXT,
    STATUS_NONE,
    STATUS_PAUSED,
    STATUS_PLAYING,
    STATUS_STOPPED,
    NowPlaying,
)

_UNSUPPORTED: Final = "o Tocando agora só existe no Windows"
_TIMEOUT_SECONDS: Final = 8

# O estado do Windows (`GlobalSystemMediaTransportControlsSessionPlaybackStatus`) no do contrato.
_STATUS: Final = {"Playing": STATUS_PLAYING, "Paused": STATUS_PAUSED}

_SCRIPT: Final = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(5000)
  $task.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, @WINRT]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, @WINRT]
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType
$session = $manager.GetCurrentSession()
if ($null -eq $session) { $result = @{ status = 'None' } }
else {
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
  $result = @{
    status = $session.GetPlaybackInfo().PlaybackStatus.ToString()
    title = [string]$props.Title
    artist = [string]$props.Artist
    app = [string]$session.SourceAppUserModelId
  }
}
$json = $result | ConvertTo-Json -Compress
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
""".replace("@WINRT", "Windows.Media.Control, ContentType = WindowsRuntime")

# O que o executor devolve: código de saída e o que o script escreveu.
Runner = Callable[[], tuple[int, str]]


def _powershell() -> str:
    return os.path.join(
        os.environ["SystemRoot"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    )


def _run_script() -> tuple[int, str]:
    if sys.platform != "win32":
        raise PcUnsupported(_UNSUPPORTED)
    encoded = base64.b64encode(_SCRIPT.encode("utf-16-le")).decode("ascii")
    done = run_hidden(
        [
            _powershell(),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_SECONDS,
    )
    return done.returncode, done.stdout or ""


def _clean(value: object) -> str:
    """O texto sem caractere de controle e dentro do limite do contrato."""
    if not isinstance(value, str):
        return ""
    cleaned = "".join(ch for ch in value if ch.isprintable()).strip()
    return cleaned[:MAX_MEDIA_TEXT]


def parse_now_playing(output: str) -> NowPlaying:
    """Lê a saída do script (JSON em base64). Qualquer coisa fora do formato é `OSError`: o agente
    responde que não conseguiu ler, em vez de inventar uma faixa."""
    try:
        data = json.loads(base64.b64decode(output.strip(), validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise OSError("o Windows não devolveu a sessão de mídia") from exc
    if not isinstance(data, dict):
        raise OSError("o Windows não devolveu a sessão de mídia")
    raw_status = data.get("status")
    if raw_status == "None":
        return NowPlaying(STATUS_NONE)
    status = _STATUS.get(raw_status, STATUS_STOPPED) if isinstance(raw_status, str) else None
    if status is None:
        raise OSError("o Windows não devolveu a sessão de mídia")
    return NowPlaying(
        status,
        title=_clean(data.get("title")),
        artist=_clean(data.get("artist")),
        app=_clean(data.get("app")),
    )


class WindowsPcMediaSession:
    """A sessão de mídia do Windows. `run` é trocável: os testes nunca iniciam o PowerShell."""

    def __init__(self, run: Runner | None = None) -> None:
        self._run = run or _run_script

    def read(self) -> NowPlaying:
        code, output = self._run()
        if code != 0:
            raise OSError(f"a leitura da sessão de mídia falhou (código {code})")
        return parse_now_playing(output)
