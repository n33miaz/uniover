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


def webp_bytes(
    width: int = 64, height: int | None = None, *, kind: str = "VP8L", animated: bool = False
) -> bytes:
    """WebP sintético com cabeçalho de verdade: é o que o núcleo lê para saber o tamanho.

    `kind` escolhe o tipo (`VP8L` sem perda, `VP8 ` com perda, `VP8X` estendido).
    """
    high = width if height is None else height
    if kind == "VP8L":
        bits = (width - 1) | ((high - 1) << 14)
        payload = b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 8
    elif kind == "VP8 ":
        payload = b"\x00\x00\x00\x9d\x01\x2a" + struct.pack("<HH", width, high) + b"\x00" * 8
    elif kind == "VP8X":
        flags = 0x02 if animated else 0x10
        payload = bytes([flags, 0, 0, 0]) + (width - 1).to_bytes(3, "little")
        payload += (high - 1).to_bytes(3, "little")
    else:
        raise ValueError(kind)
    chunk = kind.encode() + struct.pack("<I", len(payload)) + payload
    if len(payload) % 2:
        chunk += b"\x00"
    return b"RIFF" + struct.pack("<I", len(chunk) + 4) + b"WEBP" + chunk


# Saída real de `aapt2 dump badging` do CineVS na TV (só as linhas que importam; o resto do arquivo
# repete rótulos por idioma). Todo `application-icon-*` é XML (ícone adaptativo) e o único PNG que o
# `badging` mostra é o `banner` 16:9, que nunca serve de ícone.
BADGING_ADAPTIVE_WITH_BANNER = """\
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

# `aapt2 dump resources` do CineVS (só os blocos que importam): o mesmo recurso do XML adaptativo
# (`res/BW.xml`) traz o ícone legado em WebP nas cinco densidades; o bloco vizinho é a camada da
# frente (`ic_launcher_foreground`), que também é WebP quadrado e não pode virar ícone.
RESOURCES_CINEVS = """\
Package name=com.cnvs.apptv id=7f
  type drawable id=08 entryCount=1
    resource 0x7f080001 drawable/ic_banner
      (xhdpi) (file) res/Ec.png type=PNG
  type mipmap id=0f entryCount=2
    resource 0x7f0f0000 mipmap/ic_launcher
      (mdpi) (file) res/d2.webp
      (hdpi) (file) res/MO.webp
      (xhdpi) (file) res/qs.webp
      (xxhdpi) (file) res/Sn.webp
      (xxxhdpi) (file) res/sK.webp
      (anydpi-v26) (file) res/BW.xml type=XML
    resource 0x7f0f0001 mipmap/ic_launcher_foreground
      (mdpi) (file) res/Nt.webp
      (hdpi) (file) res/13.webp
      (xhdpi) (file) res/9Q.webp
      (xxhdpi) (file) res/iE.webp
      (xxxhdpi) (file) res/5c.webp
  type plurals id=10 entryCount=1
    resource 0x7f100000 plurals/exo_controls_fastforward_by_amount_description
      () (plurals) size=2
        one="Fast forward %d second"
"""

# Spotify: ícone adaptativo em todas as densidades; o legado em PNG está no mesmo recurso.
BADGING_SPOTIFY = """\
package: name='com.spotify.tv.android' versionCode='2340200' versionName='1.134.2'
application-label:'Spotify'
application-icon-160:'res/mipmap-anydpi-v26/spotify_icon.xml'
application-icon-320:'res/mipmap-anydpi-v26/spotify_icon.xml'
application-icon-640:'res/mipmap-anydpi-v26/spotify_icon.xml'
application-icon-65534:'res/mipmap-anydpi-v26/spotify_icon.xml'
application: label='Spotify' icon='res/mipmap-anydpi-v26/spotify_icon.xml' banner='res/banner.png'
launchable-activity: name='com.spotify.tv.android.TvActivity'  label='Spotify' icon=''
leanback-launchable-activity: name='com.spotify.tv.android.TvActivity'  icon='' banner=''
"""

RESOURCES_SPOTIFY = """\
Package name=com.spotify.tv.android id=7f
  type drawable id=08 entryCount=2
    resource 0x7f080056 drawable/banner
      (xhdpi) (file) res/banner.png type=PNG
    resource 0x7f080195 drawable/spotify_icon_background
      (anydpi) (file) res/drawable-anydpi-v21/spotify_icon_background.png type=PNG
  type mipmap id=0e entryCount=2
    resource 0x7f0e0000 mipmap/spotify_icon
      (mdpi) (file) res/mipmap-mdpi-v4/spotify_icon.png type=PNG
      (hdpi) (file) res/mipmap-hdpi-v4/spotify_icon.png type=PNG
      (xhdpi) (file) res/mipmap-xhdpi-v4/spotify_icon.png type=PNG
      (xxhdpi) (file) res/mipmap-xxhdpi-v4/spotify_icon.png type=PNG
      (xxxhdpi) (file) res/mipmap-xxxhdpi-v4/spotify_icon.png type=PNG
      (anydpi-v26) (file) res/mipmap-anydpi-v26/spotify_icon.xml type=XML
    resource 0x7f0e0002 mipmap/spotify_icon_foreground
      (mdpi) (file) res/mipmap-mdpi-v4/spotify_icon_foreground.png type=PNG
      (xxxhdpi) (file) res/mipmap-xxxhdpi-v4/spotify_icon_foreground.png type=PNG
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
        self.resources: dict[bytes, str] = {}
        self.resources_dumped = 0
        self.resources_error: IconToolError | None = None

    async def dump_badging(self, apk: Path) -> str:
        if self.badging_error is not None:
            raise self.badging_error
        return self.badging.get(apk.read_bytes(), "")  # noqa: ASYNC240

    async def dump_resources(self, apk: Path) -> str:
        self.resources_dumped += 1
        if self.resources_error is not None:
            raise self.resources_error
        return self.resources.get(apk.read_bytes(), "")  # noqa: ASYNC240

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
