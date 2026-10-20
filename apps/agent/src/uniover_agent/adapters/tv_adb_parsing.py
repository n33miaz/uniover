"""Leitura da saída do `adb` e montagem segura dos comandos que vão para o shell da TV.

Tudo aqui é puro (sem processo, sem rede) e testado com amostras reais da TV. Duas armadilhas que
moldam este módulo:

* a TV mistura linhas de ruído na saída ("Init wrapper sys mutex successful...", "open mma dev
  failed") e o `adb` no Windows usa CRLF: os leitores procuram só o que lhes interessa, nunca
  assumem a primeira ou a última linha;
* tudo o que vem depois de `adb shell` roda no shell da TV. Passar o `argv` em lista protege só o
  lado do Windows; por isso todo dado externo é validado por padrão restrito e o texto vai entre
  aspas simples.
"""

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from uniover_agent.ports import LaunchableApp, is_adb_typable

# Mesmo padrão do contrato (`tv.app.launch.v1` com `kind=package`).
PACKAGE_PATTERN: Final = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+")
MAX_PACKAGE_LENGTH: Final = 255
# Atividade: `.Main`, `Main` ou `com.exemplo.Main` (`$` só para classe interna). O componente vai
# sempre entre aspas simples, onde o shell da TV não expande o `$`. Atividade que não passa aqui
# cai no lançador padrão do pacote.
ACTIVITY_PATTERN: Final = re.compile(r"\.?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*")
MAX_ACTIVITY_LENGTH: Final = 255

# Caminho de APK na TV (`pm path`): só os caracteres que a TV realmente usa (`~~`, `==`, `-`, `_`).
# Sem espaço, aspas, `$` nem `..`. Vai ao `adb pull` (sem shell), mas segue validado.
REMOTE_APK_PATTERN: Final = re.compile(r"/(?:[A-Za-z0-9_.@+=~-]+/)*[A-Za-z0-9_.@+=~-]+\.apk")
MAX_REMOTE_PATH_LENGTH: Final = 512

# Linhas que a TV imprime antes da resposta de verdade; ignoradas em qualquer leitor.
NOISE_PREFIXES: Final = ("Init wrapper sys mutex", "open mma dev failed")

# Componente como `pacote/atividade` numa linha sozinha (formato de `query-activities --brief`).
_COMPONENT_LINE: Final = re.compile(r"^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/(\S+)$")


_PACKAGE_VERSION_LINE: Final = re.compile(r"^package:(\S+)\s+versionCode:(\d+)")


class DeviceState(StrEnum):
    DEVICE = "device"
    UNAUTHORIZED = "unauthorized"
    OFFLINE = "offline"
    NOT_FOUND = "not_found"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class AdbOutput:
    """O que um comando do `adb` devolveu: código de saída e o texto das duas saídas juntas."""

    returncode: int
    text: str


def clean_lines(text: str) -> list[str]:
    """Linhas sem espaços nas pontas, sem vazias e sem o ruído da TV (aceita CRLF)."""
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith(NOISE_PREFIXES):
            lines.append(line)
    return lines


def parse_device_state(text: str) -> DeviceState:
    """Estado da TV segundo `adb get-state` (o erro vem na saída de erro, com código 1)."""
    state = DeviceState.UNKNOWN
    for line in clean_lines(text):
        lowered = line.lower()
        if lowered == "device":
            return DeviceState.DEVICE
        if "unauthorized" in lowered:
            return DeviceState.UNAUTHORIZED
        if "offline" in lowered:
            state = DeviceState.OFFLINE
        elif "not found" in lowered or "no devices" in lowered:
            state = DeviceState.NOT_FOUND
    return state


def parse_connect(text: str) -> bool:
    """`adb connect` deu certo (inclusive "already connected")."""
    for line in clean_lines(text):
        lowered = line.lower()
        if lowered.startswith(("connected to", "already connected to")):
            return True
    return False


def connect_was_refused_for_auth(text: str) -> bool:
    """Versões novas do `adb` recusam o `connect` quando a chave ainda não foi aceita."""
    return any("authenticate" in line.lower() for line in clean_lines(text))


def parse_launchable(text: str) -> list[LaunchableApp]:
    """Apps de `cmd package query-activities --brief`, um por pacote, na ordem da TV."""
    found: list[LaunchableApp] = []
    seen: set[str] = set()
    for line in clean_lines(text):
        match = _COMPONENT_LINE.match(line)
        if match is None:
            continue
        package, activity = match.group(1), match.group(2)
        if package in seen or len(package) > MAX_PACKAGE_LENGTH:
            continue
        seen.add(package)
        found.append(LaunchableApp(package, activity))
    return found


def parse_package_list(text: str) -> set[str]:
    """Pacotes de `pm list packages` (linhas `package:com.exemplo.app`)."""
    packages: set[str] = set()
    for line in clean_lines(text):
        if line.startswith("package:"):
            name = line.removeprefix("package:").strip()
            if is_valid_package(name):
                packages.add(name)
    return packages


def is_valid_remote_apk_path(path: str) -> bool:
    return (
        len(path) <= MAX_REMOTE_PATH_LENGTH
        and REMOTE_APK_PATTERN.fullmatch(path) is not None
        and ".." not in path.split("/")
    )


def parse_package_paths(text: str) -> list[str]:
    """Caminhos de `pm path` (linhas `package:/data/app/.../base.apk`), o `base.apk` primeiro.

    Apps com APKs divididos devolvem várias linhas. Linha com caminho fora do formato é ignorada.
    """
    paths: list[str] = []
    for line in clean_lines(text):
        if line.startswith("package:"):
            path = line.removeprefix("package:").strip()
            if is_valid_remote_apk_path(path) and path not in paths:
                paths.append(path)
    paths.sort(key=lambda path: not path.endswith("/base.apk"))
    return paths


def parse_package_versions(text: str) -> dict[str, int]:
    """`pm list packages --show-versioncode`: linhas `package:com.exemplo.app versionCode:123`."""
    versions: dict[str, int] = {}
    for line in clean_lines(text):
        match = _PACKAGE_VERSION_LINE.match(line)
        if match and is_valid_package(match.group(1)):
            versions[match.group(1)] = int(match.group(2))
    return versions


def am_start_succeeded(text: str) -> bool:
    """`am start` sai com 0 até quando falha: só a saída diz ("Error: ...", "Error type 3")."""
    lines = clean_lines(text)
    if any(line.startswith("Error") or "Exception" in line for line in lines):
        return False
    return any(line.startswith("Starting:") for line in lines)


def monkey_succeeded(text: str) -> bool:
    lines = clean_lines(text)
    if any("No activities found" in line or "monkey aborted" in line for line in lines):
        return False
    return any(line.startswith("Events injected: 1") for line in lines)


# --- entrada do usuário ------------------------------------------------------------------------


def is_valid_package(package: str) -> bool:
    return len(package) <= MAX_PACKAGE_LENGTH and PACKAGE_PATTERN.fullmatch(package) is not None


def is_valid_activity(activity: str) -> bool:
    return len(activity) <= MAX_ACTIVITY_LENGTH and ACTIVITY_PATTERN.fullmatch(activity) is not None


def quote_for_device_shell(text: str) -> str:
    """Entre aspas simples, que no shell da TV não interpretam nada (a aspa vira `'\''`)."""
    return "'" + text.replace("'", "'\\''") + "'"


def input_text_command(text: str) -> str:
    """Comando `input text` para um texto que passou em `is_adb_typable` (espaço vira `%s`)."""
    if not is_adb_typable(text):
        raise ValueError("texto fora do que o ADB digita com fidelidade")
    return "input text " + quote_for_device_shell(text.replace(" ", "%s"))
