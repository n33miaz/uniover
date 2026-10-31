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


# --- limpeza da TV -----------------------------------------------------------------------------

_MEM_AVAILABLE_LINE: Final = re.compile(r"^MemAvailable:\s+(\d+)\s*kB\b", re.IGNORECASE)
# `settings get` escreve a palavra `null` quando o valor não existe.
_SETTING_NULL: Final = "null"


def parse_mem_available_mb(text: str) -> int | None:
    """`MemAvailable` de `/proc/meminfo` (linha `MemAvailable:   262144 kB`), em MB inteiros."""
    for line in clean_lines(text):
        match = _MEM_AVAILABLE_LINE.match(line)
        if match is not None:
            return int(match.group(1)) // 1024
    return None


def parse_setting_value(text: str) -> str | None:
    """Valor de `settings get`: a primeira linha útil, ou `None` para `null` e para saída vazia."""
    lines = clean_lines(text)
    if not lines or lines[0].lower() == _SETTING_NULL:
        return None
    return lines[0]


def parse_component_packages(value: str | None) -> frozenset[str]:
    """Pacotes de uma lista de componentes (`pacote/Classe:pacote2/Classe2`), validados um a um.

    O IME vem como um componente só e os serviços de acessibilidade, separados por dois-pontos.
    Parte fora do formato do Android é ignorada: nada vindo da TV vira argumento de comando.
    """
    if value is None:
        return frozenset()
    packages: set[str] = set()
    for component in value.split(":"):
        package = component.split("/", 1)[0].strip()
        if is_valid_package(package):
            packages.add(package)
    return frozenset(packages)


# `dumpsys media_session`: cada sessão abre com "TAG pacote/TAG (userId=0)", traz `package=pacote`
# e, mais abaixo, `state=PlaybackState {state=3, ...}` (3 = tocando).
_SESSION_HEADER: Final = re.compile(r"\(userId=\d+\)$")
_SESSION_PACKAGE: Final = re.compile(r"^package=(\S+)$")
_PLAYBACK_STATE: Final = re.compile(r"PlaybackState[^\n]*?state=(\d+)")


def parse_playback_sessions(text: str) -> list[tuple[str | None, int]]:
    """Cada `PlaybackState` de `dumpsys media_session` com o pacote dono da sessão.

    O dono é `None` quando a sessão não declarou `package=` antes do estado: quem lê trata isso
    como dúvida, nunca como "qualquer app".
    """
    package: str | None = None
    sessions: list[tuple[str | None, int]] = []
    for line in clean_lines(text):
        if _SESSION_HEADER.search(line):
            package = None
        elif (owner := _SESSION_PACKAGE.match(line)) is not None:
            package = owner[1] if is_valid_package(owner[1]) else None
        elif (state := _PLAYBACK_STATE.search(line)) is not None:
            sessions.append((package, int(state[1])))
    return sessions


def parse_running_packages(text: str) -> frozenset[str]:
    """Pacotes com processo vivo, de `ps -A`: o nome do processo é a última coluna de cada linha.

    Processo secundário de app (`pacote:servico`) conta para o pacote. Threads do kernel
    (`[kworker/0:1]`), executáveis (`/system/bin/...`) e o cabeçalho (`NAME`) não têm o formato de
    um pacote e ficam de fora.
    """
    running: set[str] = set()
    for line in clean_lines(text):
        name = line.split()[-1].split(":", 1)[0]
        if is_valid_package(name):
            running.add(name)
    return frozenset(running)


def command_succeeded(output: AdbOutput) -> bool:
    """`am` e `input` saem com 0 quando dão certo e escrevem `Error...` ou `Exception...` se não."""
    if output.returncode != 0:
        return False
    return not any(
        line.startswith("Error") or "Exception" in line for line in clean_lines(output.text)
    )


# --- volume lido pelo shell (para a TV cujo canal remoto não informa o nível) ----------------

# `cmd media_session volume --stream 3 --get` (3 = música): "volume is 7 in range [0..15]".
_MEDIA_SESSION_VOLUME: Final = re.compile(
    r"volume\s+is\s+(\d+)\s+in\s+range\s+\[(\d+)\.\.(\d+)\]", re.IGNORECASE
)
_MUSIC_MIN: Final = re.compile(r"^\s*Min:\s*(\d+)\s*$", re.MULTILINE)
_MUSIC_MAX: Final = re.compile(r"^\s*Max:\s*(\d+)\s*$", re.MULTILINE)
_MUSIC_DEVICES: Final = re.compile(r"^\s*Devices:\s*(.+?)\s*$", re.MULTILINE)
_MUSIC_CURRENT: Final = re.compile(r"^\s*Current:\s*(.+?)\s*$", re.MULTILINE)
# Entrada de `Current:`: "2 (speaker): 8" ou "40000000 (default): 11".
_MUSIC_ENTRY: Final = re.compile(r"\d+\s*\(([^)]*)\)\s*:\s*(\d+)")


def volume_percent_of(level: int, minimum: int, maximum: int) -> int | None:
    """O nível da TV (`minimum` a `maximum`) em porcentagem; `None` se a faixa não faz sentido."""
    if maximum <= minimum or not minimum <= level <= maximum:
        return None
    return round((level - minimum) * 100 / (maximum - minimum))


def parse_media_session_volume(text: str) -> int | None:
    """O volume de música (0 a 100) de `cmd media_session volume --get`; `None` se não vem."""
    match = _MEDIA_SESSION_VOLUME.search(text)
    if match is None:
        return None
    return volume_percent_of(int(match[1]), int(match[2]), int(match[3]))


def parse_dumpsys_music_volume(text: str) -> int | None:
    """O volume de música (0 a 100) do bloco `STREAM_MUSIC` de `dumpsys audio`.

    Com a saída de som por HDMI-ARC/CEC o bloco lista um nível por saída e diz em `Devices:` qual
    está ativa; vale a ativa e, sem a linha, o primeiro nível listado.
    """
    start = text.find("- STREAM_MUSIC:")
    if start < 0:
        return None
    block = text[start + len("- STREAM_MUSIC:") :]
    following = re.search(r"^\s*- STREAM_[A-Z_]+:", block, re.MULTILINE)
    if following is not None:
        block = block[: following.start()]
    low, high, current = (
        _MUSIC_MIN.search(block),
        _MUSIC_MAX.search(block),
        _MUSIC_CURRENT.search(block),
    )
    if low is None or high is None or current is None:
        return None
    entries = _MUSIC_ENTRY.findall(current[1])
    if not entries:
        return None
    active = _MUSIC_DEVICES.search(block)
    chosen = entries[0]
    if active is not None:
        names = {name.strip().casefold() for name in active[1].split(",")}
        chosen = next((entry for entry in entries if entry[0].strip().casefold() in names), chosen)
    return volume_percent_of(int(chosen[1]), int(low[1]), int(high[1]))
