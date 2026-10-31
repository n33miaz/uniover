"""Leitura do volume por mais de um caminho: shell da Android TV, reserva do canal remoto e o
diagnóstico `tv-volume`. Nada de rede nem de TV de verdade: `adb` e UPnP são dublês."""

import httpx
import pytest

from uniover_agent.adapters import tv_samsung_volume as volume_module
from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import (
    parse_dumpsys_music_volume,
    parse_media_session_volume,
    volume_percent_of,
)
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume
from uniover_agent.adapters.tv_volume_check import check_volume
from uniover_agent.core import TvSessionManager
from uniover_agent.core.domain import TvState
from uniover_agent.main import volume_reader_when_push_is_silent

from .support_adb import ADB, HOST, FakeAdbRunner, ok, shell

MEDIA_SESSION = shell("cmd media_session volume --stream 3 --get")
DUMPSYS = shell("dumpsys audio")

DUMPSYS_SPEAKER = """
- STREAM_RING:
   Muted: false
   Min: 0
   Max: 7
   Current: 2 (speaker): 4
- STREAM_MUSIC:
   Muted: false
   Min: 0
   Max: 15
   Current: 2 (speaker): 3, 40000000 (default): 11
   Devices: speaker
- STREAM_ALARM:
   Muted: false
   Min: 1
   Max: 7
   Current: 2 (speaker): 6
"""
DUMPSYS_ARC = DUMPSYS_SPEAKER.replace(
    "Current: 2 (speaker): 3, 40000000 (default): 11\n   Devices: speaker",
    "Current: 2 (speaker): 3, 40000 (hdmi_arc): 9\n   Devices: hdmi_arc",
)


def tv_with(script: dict[tuple[str, ...], object]) -> tuple[AdbTv, FakeAdbRunner]:
    runner = FakeAdbRunner()
    runner.connected()
    runner.script.update(script)  # type: ignore[arg-type]
    return AdbTv(ADB, HOST, 5555, timeout=1.0, runner=runner), runner


def test_the_media_session_answer_becomes_a_percentage() -> None:
    assert parse_media_session_volume("Volume is 3 in range [0..15]\r\n") == 20
    assert parse_media_session_volume("volume is 15 in range [0..15]") == 100
    assert parse_media_session_volume("volume is 0 in range [0..15]") == 0


@pytest.mark.parametrize(
    "text",
    ["", "Error: unknown command", "volume is 3 in range [5..5]", "volume is 99 in range [0..15]"],
)
def test_a_media_session_answer_that_makes_no_sense_is_unknown(text: str) -> None:
    assert parse_media_session_volume(text) is None


def test_the_music_block_of_dumpsys_is_read_for_the_active_output() -> None:
    assert parse_dumpsys_music_volume(DUMPSYS_SPEAKER) == 20
    # Com a saída pela soundbar (ARC) vale o nível da saída ativa, não o do alto-falante da TV.
    assert parse_dumpsys_music_volume(DUMPSYS_ARC) == 60
    # Sem a linha de saída ativa vale o primeiro nível listado.
    assert parse_dumpsys_music_volume(DUMPSYS_SPEAKER.replace("   Devices: speaker\n", "")) == 20


@pytest.mark.parametrize(
    "text",
    [
        "",
        "- STREAM_MUSIC:\n   Muted: false\n",
        "- STREAM_RING:\n   Min: 0\n   Max: 7\n   Current: 2 (speaker): 4",
    ],
)
def test_a_dumpsys_without_a_usable_music_block_is_unknown(text: str) -> None:
    assert parse_dumpsys_music_volume(text) is None


def test_the_percentage_needs_a_sane_range() -> None:
    assert volume_percent_of(5, 0, 10) == 50
    assert volume_percent_of(1, 1, 7) == 0
    assert volume_percent_of(5, 3, 3) is None
    assert volume_percent_of(20, 0, 10) is None


async def test_the_shell_reads_the_music_volume_from_media_session_first() -> None:
    tv, runner = tv_with({MEDIA_SESSION: ok("volume is 6 in range [0..15]\r\n")})
    assert await tv.read_volume() == 40
    assert runner.shell_commands() == ["cmd media_session volume --stream 3 --get"]


async def test_the_shell_falls_back_to_dumpsys_when_media_session_has_nothing() -> None:
    tv, runner = tv_with(
        {
            MEDIA_SESSION: ok("Error: Unknown command: volume\r\n", returncode=255),
            DUMPSYS: ok(DUMPSYS_ARC),
        }
    )
    assert await tv.read_volume() == 60
    assert runner.shell_commands() == [
        "cmd media_session volume --stream 3 --get",
        "dumpsys audio",
    ]


async def test_the_shell_says_unknown_when_neither_command_gives_a_level() -> None:
    tv, _ = tv_with({MEDIA_SESSION: ok("nothing"), DUMPSYS: ok("- STREAM_MUSIC:\n")})
    assert await tv.read_volume() is None


async def test_the_shell_diagnosis_reports_each_command() -> None:
    tv, _ = tv_with({MEDIA_SESSION: ok("", returncode=1), DUMPSYS: ok(DUMPSYS_SPEAKER)})
    assert await tv.diagnose_volume() == [
        ("media_session", False, "o comando falhou ou não existe nesta TV"),
        ("dumpsys-audio", True, "nível 20"),
    ]


class FakeManager:
    def __init__(self, volume: int | None) -> None:
        self.volume = volume

    @property
    def remote_volume_seen(self) -> bool:
        return self.volume is not None

    def snapshot(self) -> TvState:
        return TvState("on", self.volume, None, "hot")


class PushOnKey(FakeTvRemote):
    next_level: int | None = None

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        await super().send_key(key, direction)
        if self.next_level is not None:
            self.push_volume(self.next_level)
            self.next_level = None


async def test_the_shell_is_only_asked_while_the_remote_channel_has_not_pushed_a_level() -> None:
    tv, runner = tv_with({MEDIA_SESSION: ok("volume is 15 in range [0..15]")})
    manager = FakeManager(None)
    read = volume_reader_when_push_is_silent(manager, tv)  # type: ignore[arg-type]
    assert await read() == 100
    # O canal remoto já deu um nível: o `adb` não vira carga extra a cada tecla.
    manager.volume = 30
    runner.calls.clear()
    assert await read() is None
    assert runner.shell_commands() == []


# --- diagnóstico `tv-volume` ----------------------------------------------------------------


def upnp(volume: int | None) -> httpx.MockTransport:
    def respond(request: httpx.Request) -> httpx.Response:
        if volume is not None and request.method == "POST":
            body = f"<e><CurrentVolume>{volume}</CurrentVolume></e>"
            return httpx.Response(200, text=body)
        return httpx.Response(404)

    return httpx.MockTransport(respond)


async def test_the_check_names_the_path_that_answered_and_exits_zero() -> None:
    lines: list[str] = []
    samsung = SamsungVolume("192.168.0.11", transport=upnp(33), discover=lambda _h: [])
    assert await check_volume("samsung", samsung=samsung, out=lines.append) == 0
    text = "\n".join(lines)
    assert f"[ok] {volume_module.METHOD_DIRECT}" in text
    assert "Volume lido por" in text
    assert "192.168" not in text


async def test_the_check_explains_when_no_path_answers_and_exits_one() -> None:
    lines: list[str] = []
    samsung = SamsungVolume("192.168.0.11", transport=upnp(None), discover=lambda _h: [])
    assert await check_volume("samsung", samsung=samsung, out=lines.append) == 1
    assert any("Nenhum caminho devolveu o volume" in line for line in lines)


async def test_the_check_for_android_uses_the_shell_and_survives_a_dead_adb() -> None:
    lines: list[str] = []
    tv, _ = tv_with({MEDIA_SESSION: ok("volume is 3 in range [0..15]"), DUMPSYS: ok("")})
    assert await check_volume("android", adb=tv, out=lines.append) == 0
    assert any("media_session" in line and "nível 20" in line for line in lines)

    lines.clear()
    assert await check_volume("android", adb=None, out=lines.append) == 1
    assert any("adb" in line for line in lines)

    broken = FakeAdbRunner()  # sem roteiro: a primeira chamada falha
    dead = AdbTv(ADB, HOST, 5555, timeout=1.0, runner=broken)
    lines.clear()
    assert await check_volume("android", adb=dead, out=lines.append) == 1


async def test_a_reader_given_after_creation_is_used_on_open_and_after_a_volume_key() -> None:
    manager = TvSessionManager(FakeClock(), FakeTvRemote())
    levels = iter([12, 13])

    async def reader() -> int | None:
        return next(levels)

    manager.set_volume_reader(reader)
    await manager.wake()
    await manager.settle()
    assert manager.snapshot().volume == 12
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 13
    await manager.aclose()


async def test_adb_fallback_keeps_reading_after_two_keys_without_remote_push() -> None:
    tv, runner = tv_with({MEDIA_SESSION: ok("volume is 3 in range [0..15]")})
    remote = PushOnKey()
    manager = TvSessionManager(FakeClock(), remote)
    manager.set_volume_reader(volume_reader_when_push_is_silent(manager, tv))

    await manager.wake()
    await manager.settle()
    assert manager.snapshot().volume == 20

    runner.script[MEDIA_SESSION] = ok("volume is 6 in range [0..15]")
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 40

    runner.script[MEDIA_SESSION] = ok("volume is 9 in range [0..15]")
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 60
    assert runner.shell_commands() == ["cmd media_session volume --stream 3 --get"] * 3

    remote.next_level = 70
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 70
    assert runner.shell_commands() == ["cmd media_session volume --stream 3 --get"] * 3
    await manager.aclose()


async def test_initial_push_does_not_disable_fallback_after_later_silent_keys() -> None:
    tv, runner = tv_with({MEDIA_SESSION: ok("volume is 3 in range [0..15]")})
    remote = PushOnKey()
    remote.on_connect = lambda: remote.push_volume(10)
    manager = TvSessionManager(FakeClock(), remote)
    manager.set_volume_reader(volume_reader_when_push_is_silent(manager, tv))

    await manager.wake()
    await manager.settle()
    assert manager.snapshot().volume == 10
    assert runner.shell_commands() == []

    runner.script[MEDIA_SESSION] = ok("volume is 6 in range [0..15]")
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 40

    runner.script[MEDIA_SESSION] = ok("volume is 9 in range [0..15]")
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 60
    assert runner.shell_commands() == ["cmd media_session volume --stream 3 --get"] * 2

    remote.next_level = 70
    await manager.send_key("VOLUME_UP")
    await manager.settle()
    assert manager.snapshot().volume == 70
    assert runner.shell_commands() == ["cmd media_session volume --stream 3 --get"] * 2
    await manager.aclose()
