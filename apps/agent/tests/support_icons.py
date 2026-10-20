"""Apoio dos testes dos ícones: imagens sintéticas, amostras do `aapt2` e dublês das portas."""

import struct
import zlib
from pathlib import Path

from uniover_agent.ports import (
    AdbCommandFailed,
    AdbError,
    AppIcon,
    CachedIcon,
    IconToolError,
)


def png_bytes(width: int = 4, height: int = 4, *, pad_to: int = 0) -> bytes:
    """PNG válido gerado na hora (nenhum arquivo de app de terceiros entra no repositório).

    `pad_to` acrescenta um trecho de texto (que o PNG ignora) para chegar ao peso desejado.
    """
    raw = b"".join(b"\x00" + bytes((229, 9, 20, 255)) * width for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return (
            struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    parts = [b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", header), chunk(b"IDAT", zlib.compress(raw))]
    # tEXt = 12 bytes de moldura + "k\0" + o enchimento; o IEND que fecha o arquivo pesa mais 12.
    filler = pad_to - sum(map(len, parts)) - 12 - 2 - 12
    if filler > 0:
        parts.append(chunk(b"tEXt", b"k\x00" + b"x" * filler))
    parts.append(chunk(b"IEND", b""))
    return b"".join(parts)


def webp_bytes(size: int = 64) -> bytes:
    return b"RIFF" + struct.pack("<I", size - 8) + b"WEBP" + b"VP8 " + b"\x00" * (size - 16)


# Saída real de `aapt2 dump badging` do CineVS na TV (só as linhas que importam; o resto do arquivo
# repete rótulos por idioma). Todo `application-icon-*` é XML: só o `banner` é PNG.
BADGING_BANNER_ONLY = """\
package: name='com.cnvs.apptv' versionCode='50' versionName='5.0' platformBuildVersionName='16'
minSdkVersion:'23'
application-label:'CineVS TV'
application-icon-120:'res/BW.xml'
application-icon-160:'res/BW.xml'
application-icon-240:'res/BW.xml'
application-icon-320:'res/BW.xml'
application-icon-480:'res/BW.xml'
application-icon-640:'res/BW.xml'
application-icon-65534:'res/BW.xml'
application: label='CineVS TV' icon='res/BW.xml' banner='res/Ec.png'
launchable-activity: name='com.cnvs.apptv.ui.LoginActivity'  label='' icon=''
leanback-launchable-activity: name='com.cnvs.apptv.ui.LoginActivity'  label='' icon='' banner=''
densities: '120' '160' '240' '320' '480' '640' '65534'
"""

# App clássico: ícones em PNG por densidade, mais um adaptativo (XML) em "qualquer densidade".
BADGING_DENSITIES = """\
package: name='com.exemplo.player' versionCode='7' versionName='1.2'
application-label:'Player'
application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'
application-icon-320:'res/mipmap-xhdpi-v4/ic_launcher.png'
application-icon-640:'res/mipmap-xxxhdpi-v4/ic_launcher.png'
application-icon-480:'res/mipmap-xxhdpi-v4/ic_launcher.png'
application-icon-65534:'res/mipmap-anydpi-v26/ic_launcher.xml'
application: label='Player' icon='res/mipmap-anydpi-v26/ic_launcher.xml'
launchable-activity: name='com.exemplo.player.Main'  label='' icon=''
"""

BADGING_ALL_XML = """\
package: name='com.exemplo.xml' versionCode='3'
application-icon-320:'res/a.xml'
application-icon-65534:'res/a.xml'
application: label='X' icon='res/a.xml'
launchable-activity: name='com.exemplo.xml.Main'  label='' icon='res/b.xml'
"""


class FakeApkSource:
    """O lado da TV: versões, caminhos e uma "cópia" que grava os bytes combinados."""

    def __init__(self) -> None:
        self.versions: dict[str, int] = {}
        self.paths: dict[str, list[str]] = {}
        self.apks: dict[str, bytes] = {}
        self.pulled: list[str] = []
        self.errors: dict[str, AdbError] = {}
        self.version_error: AdbError | None = None

    async def package_versions(self) -> dict[str, int]:
        if self.version_error is not None:
            raise self.version_error
        return dict(self.versions)

    async def apk_paths(self, package: str) -> list[str]:
        if package in self.errors:
            raise self.errors[package]
        return list(self.paths.get(package, []))

    async def pull_apk(self, remote_path: str, local_path: Path) -> None:
        self.pulled.append(remote_path)
        for package, error in self.errors.items():
            if package in remote_path:
                raise error
        if remote_path not in self.apks:
            raise AdbCommandFailed("a TV não entregou o arquivo")
        local_path.write_bytes(self.apks[remote_path])  # noqa: ASYNC240


class FakeInspector:
    """`aapt2` e leitura do ZIP roteirizados por conteúdo do "APK" (os bytes copiados)."""

    def __init__(self) -> None:
        self.badging: dict[bytes, str] = {}
        self.members: dict[tuple[bytes, str], bytes] = {}
        self.read: list[str] = []
        self.badging_error: IconToolError | None = None

    async def dump_badging(self, apk: Path) -> str:
        if self.badging_error is not None:
            raise self.badging_error
        return self.badging.get(apk.read_bytes(), "")  # noqa: ASYNC240

    async def read_member(self, apk: Path, name: str, max_bytes: int) -> bytes | None:
        self.read.append(name)
        data = self.members.get((apk.read_bytes(), name))  # noqa: ASYNC240
        return None if data is None or len(data) > max_bytes else data


class MemoryIconCache:
    def __init__(self) -> None:
        self.entries: dict[tuple[str, int], AppIcon | None] = {}
        self.stored: list[tuple[str, int]] = []

    def load(self, package: str, version: int) -> CachedIcon | None:
        key = (package, version)
        return CachedIcon(self.entries[key]) if key in self.entries else None

    def store(self, package: str, version: int, icon: AppIcon | None) -> None:
        for key in [k for k in self.entries if k[0] == package]:
            del self.entries[key]
        self.entries[(package, version)] = icon
        self.stored.append((package, version))


class FolderScratch:
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.created: list[Path] = []

    def new_path(self) -> Path:
        path = self.folder / f"apk-{len(self.created)}.apk"
        self.created.append(path)
        return path

    def discard(self, path: Path) -> None:
        path.unlink(missing_ok=True)

    def leftovers(self) -> list[Path]:
        return [path for path in self.created if path.exists()]
