"""Ferramentas do Android preparadas pelo agente: download conferido, instalação atômica e procura
de novo em tempo de execução. Nada aqui sai para a rede: o HTTP é um `MockTransport` e as pastas
são do `tmp_path`."""

import asyncio
import hashlib
import io
import logging
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from uniover_agent.adapters import android_tools
from uniover_agent.adapters.android_tools import (
    AAPT2_URL,
    FAILED,
    PLATFORM_TOOLS_URL,
    READY,
    AndroidToolsInstaller,
    ProvisionError,
    ToolWatch,
    aapt2_watch,
    adb_watch,
    extract_zip,
    find_aapt2,
    parse_network_cost,
    provisioned_aapt2,
    provisioned_adb,
)
from uniover_agent.adapters.apk_tools import Aapt2Inspector
from uniover_agent.adapters.fakes import FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.composition import tv as tv_module
from uniover_agent.config import Settings
from uniover_agent.ports import AdbUnavailable, IconToolError

from .support_adb import CONNECT, HOST, FakeAdbRunner, open_gate
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv

ADB_BYTES = b"MZ adb falso"


def zip_bytes(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in entries.items():
            bundle.writestr(name, data)
        if symlink is not None:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (0o120777 << 16) & 0xFFFF0000
            bundle.writestr(info, b"../../fora")
    return buffer.getvalue()


def platform_tools_zip(**extra: bytes) -> bytes:
    return zip_bytes(
        {
            "platform-tools/adb.exe": ADB_BYTES,
            "platform-tools/AdbWinApi.dll": b"dll",
            "platform-tools/NOTICE.txt": b"aviso",
            **extra,
        }
    )


AAPT2_JAR = zip_bytes(
    {"META-INF/MANIFEST.MF": b"Manifest-Version: 1.0", "aapt2.exe": b"MZ aapt2", "NOTICE": b"x"}
)
AAPT2_JAR_SHA256 = hashlib.sha256(AAPT2_JAR).hexdigest()


class FakeGoogle:
    """Servidor falso: responde por URL e registra os pedidos."""

    def __init__(self, routes: dict[str, httpx.Response | bytes]) -> None:
        self.routes = routes
        self.requests: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        reply = self.routes.get(url)
        if reply is None:
            return httpx.Response(404)
        return reply if isinstance(reply, httpx.Response) else httpx.Response(200, content=reply)

    def factory(self) -> Callable[[], Awaitable[httpx.AsyncClient]]:
        async def make() -> httpx.AsyncClient:
            return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

        return make


class Signatures:
    def __init__(self, error: str | None = None) -> None:
        self.checked: list[bytes] = []
        self.error = error

    def __call__(self, path: Path) -> None:
        self.checked.append(path.read_bytes())
        if self.error is not None:
            raise ProvisionError(self.error)


def installer(
    base: Path, google: FakeGoogle, signatures: Signatures | None = None, **extra: Any
) -> AndroidToolsInstaller:
    return AndroidToolsInstaller(
        base,
        client_factory=google.factory(),
        verify_signature=signatures or Signatures(),
        **extra,
    )


def leftovers(base: Path) -> list[str]:
    root = base / "tools"
    return sorted(path.name for path in root.iterdir() if path.name.startswith("."))


# --- adb ---------------------------------------------------------------------------------------


async def test_adb_is_downloaded_signature_checked_and_installed_in_place(tmp_path: Path) -> None:
    google = FakeGoogle({PLATFORM_TOOLS_URL: platform_tools_zip()})
    signatures = Signatures()
    path = await installer(tmp_path, google, signatures).install_adb()
    assert path == provisioned_adb(tmp_path)
    assert path.read_bytes() == ADB_BYTES
    assert (path.parent / "AdbWinApi.dll").is_file()
    # A assinatura foi conferida no `adb.exe` extraído, antes de ele ir para o lugar final.
    assert signatures.checked == [ADB_BYTES]
    assert google.requests == [PLATFORM_TOOLS_URL]
    assert leftovers(tmp_path) == []


async def test_adb_with_a_bad_signature_is_rejected_and_nothing_is_installed(
    tmp_path: Path,
) -> None:
    google = FakeGoogle({PLATFORM_TOOLS_URL: platform_tools_zip()})
    with pytest.raises(ProvisionError, match="não está assinado"):
        await installer(
            tmp_path, google, Signatures("o adb baixado não está assinado pela Google")
        ).install_adb()
    assert not provisioned_adb(tmp_path).exists()
    assert not (tmp_path / "tools" / "platform-tools").exists()
    assert leftovers(tmp_path) == []


async def test_a_zip_slip_entry_rejects_the_whole_package(tmp_path: Path) -> None:
    evil = platform_tools_zip(**{"platform-tools/../../fora.exe": b"x"})
    google = FakeGoogle({PLATFORM_TOOLS_URL: evil})
    signatures = Signatures()
    with pytest.raises(ProvisionError, match="nome de arquivo inválido"):
        await installer(tmp_path, google, signatures).install_adb()
    assert not (tmp_path / "fora.exe").exists()
    assert not (tmp_path / "tools" / "fora.exe").exists()
    assert signatures.checked == []
    assert not provisioned_adb(tmp_path).exists()
    assert leftovers(tmp_path) == []


@pytest.mark.parametrize(
    "name", ["/abs/adb.exe", "C:/Windows/adb.exe", "platform-tools\\..\\adb.exe", "../fora.exe"]
)
def test_unsafe_member_names_are_refused(tmp_path: Path, name: str) -> None:
    archive = tmp_path / "pacote.zip"
    archive.write_bytes(zip_bytes({name: b"x"}))
    target = tmp_path / "destino"
    target.mkdir()
    with pytest.raises(ProvisionError):
        extract_zip(archive, target)
    assert list(target.iterdir()) == []


def test_symlinks_and_oversized_packages_are_refused(tmp_path: Path) -> None:
    target = tmp_path / "destino"
    target.mkdir()
    link = tmp_path / "link.zip"
    link.write_bytes(zip_bytes({"a.txt": b"x"}, symlink="b"))
    with pytest.raises(ProvisionError, match="link simbólico"):
        extract_zip(link, target)
    big = tmp_path / "grande.zip"
    big.write_bytes(zip_bytes({"a.bin": b"0" * 2000}))
    with pytest.raises(ProvisionError, match="grande demais"):
        extract_zip(big, target, max_total=1000)
    many = tmp_path / "muitos.zip"
    many.write_bytes(zip_bytes({f"{index}.txt": b"x" for index in range(5)}))
    with pytest.raises(ProvisionError, match="arquivos demais"):
        extract_zip(many, target, max_entries=4)
    assert list(target.iterdir()) == []


async def test_a_download_bigger_than_the_cap_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(android_tools, "MAX_PLATFORM_TOOLS_BYTES", 10)
    google = FakeGoogle({PLATFORM_TOOLS_URL: platform_tools_zip()})
    with pytest.raises(ProvisionError, match="grande demais"):
        await installer(tmp_path, google).install_adb()
    assert leftovers(tmp_path) == []


async def test_a_copy_placed_meanwhile_by_someone_else_wins(tmp_path: Path) -> None:
    google = FakeGoogle({PLATFORM_TOOLS_URL: platform_tools_zip()})
    theirs = provisioned_adb(tmp_path)

    def signature_and_installer_race(path: Path) -> None:
        # O instalador do Windows terminou enquanto o agente conferia a cópia dele.
        theirs.parent.mkdir(parents=True)
        theirs.write_bytes(b"do instalador")

    path = await AndroidToolsInstaller(
        tmp_path, client_factory=google.factory(), verify_signature=signature_and_installer_race
    ).install_adb()
    assert path == theirs
    assert theirs.read_bytes() == b"do instalador"
    assert leftovers(tmp_path) == []


def test_only_https_sources_are_accepted(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        AndroidToolsInstaller(tmp_path, platform_tools_url="http://exemplo.invalido/p.zip")


# --- aapt2 -------------------------------------------------------------------------------------


async def test_aapt2_is_installed_when_both_checksums_match(tmp_path: Path) -> None:
    google = FakeGoogle(
        {AAPT2_URL: AAPT2_JAR, f"{AAPT2_URL}.sha256": f"{AAPT2_JAR_SHA256}\n".encode()}
    )
    path = await installer(tmp_path, google, aapt2_sha256=AAPT2_JAR_SHA256).install_aapt2()
    assert path == provisioned_aapt2(tmp_path)
    assert path.read_bytes() == b"MZ aapt2"
    # Só o executável e o aviso de licença: o resto do `.jar` não vai para o disco.
    assert sorted(item.name for item in path.parent.iterdir()) == ["NOTICE", "aapt2.exe"]
    assert leftovers(tmp_path) == []


async def test_aapt2_with_a_published_checksum_other_than_the_pinned_one_is_rejected(
    tmp_path: Path,
) -> None:
    google = FakeGoogle({AAPT2_URL: AAPT2_JAR, f"{AAPT2_URL}.sha256": b"0" * 64})
    with pytest.raises(ProvisionError, match="não é o esperado"):
        await installer(tmp_path, google, aapt2_sha256=AAPT2_JAR_SHA256).install_aapt2()
    # O pacote nem chegou a ser baixado.
    assert google.requests == [f"{AAPT2_URL}.sha256"]
    assert not provisioned_aapt2(tmp_path).exists()


async def test_aapt2_whose_bytes_do_not_match_the_checksum_is_rejected(tmp_path: Path) -> None:
    tampered = zip_bytes({"aapt2.exe": b"trocado"})
    google = FakeGoogle({AAPT2_URL: tampered, f"{AAPT2_URL}.sha256": AAPT2_JAR_SHA256.encode()})
    with pytest.raises(ProvisionError, match="não confere"):
        await installer(tmp_path, google, aapt2_sha256=AAPT2_JAR_SHA256).install_aapt2()
    assert not provisioned_aapt2(tmp_path).exists()
    assert leftovers(tmp_path) == []


async def test_an_unreadable_published_checksum_is_rejected(tmp_path: Path) -> None:
    google = FakeGoogle({AAPT2_URL: AAPT2_JAR, f"{AAPT2_URL}.sha256": b"<html>erro</html>"})
    with pytest.raises(ProvisionError, match="ilegível"):
        await installer(tmp_path, google, aapt2_sha256=AAPT2_JAR_SHA256).install_aapt2()


def test_the_pinned_aapt2_version_and_checksum_are_one_constant_each() -> None:
    assert android_tools.AAPT2_VERSION in AAPT2_URL
    assert AAPT2_URL.startswith("https://dl.google.com/android/maven2/")
    assert len(android_tools.AAPT2_SHA256) == 64


def test_find_aapt2_falls_back_to_the_agents_own_copy(tmp_path: Path) -> None:
    assert find_aapt2(None, tmp_path) is None
    own = provisioned_aapt2(tmp_path)
    own.parent.mkdir(parents=True)
    own.write_bytes(b"x")
    assert find_aapt2(None, tmp_path) == own
    # Caminho configurado é escolha explícita: não cai na cópia do agente.
    assert find_aapt2(str(tmp_path / "nao-existe.exe"), tmp_path) is None


# --- rede ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "blocked"),
    [
        ("Unrestricted|False|False\r\n", False),
        ("Unknown|False|False", False),
        ("Fixed|False|False", True),
        ("Variable|False|False", True),
        ("Unrestricted|True|False", True),
        ("Unrestricted|False|True", True),
        ("offline", True),
        ("", False),
        ("lixo", False),
    ],
)
def test_metered_or_offline_networks_postpone_the_download(output: str, blocked: bool) -> None:
    assert (parse_network_cost(output) is not None) is blocked


# --- vigia: procura de novo e preparo em segundo plano ---------------------------------------


class Ticks:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_tool_that_appears_after_start_is_picked_up_without_restart(tmp_path: Path) -> None:
    exe = tmp_path / "adb.exe"
    ticks = Ticks()
    watch = ToolWatch(
        "adb", lambda: exe if exe.is_file() else None, monotonic=ticks, recheck_seconds=30
    )
    found: list[Path] = []
    watch.on_found(found.append)
    assert watch.path() is None
    exe.write_bytes(b"x")
    # Dentro do intervalo não procura de novo (o caminho é pedido a cada comando).
    ticks.now = 10
    assert watch.path() is None
    ticks.now = 31
    assert watch.path() == exe
    assert watch.state == READY
    assert found == [exe]
    # Sumiu do disco: volta a procurar (e não devolve um caminho morto).
    exe.unlink()
    assert watch.path() is None


async def test_the_adb_channel_resolves_the_tool_lazily(tmp_path: Path) -> None:
    exe = tmp_path / "adb.exe"
    runner = FakeAdbRunner()
    runner.connected()
    adb = AdbTv(
        lambda: exe if exe.is_file() else None,
        HOST,
        5555,
        **open_gate(),
        timeout=1.0,
        runner=runner,
        close_wait_seconds=0.05,
    )
    with pytest.raises(AdbUnavailable):
        await adb.connect()
    assert runner.calls == []
    exe.write_bytes(b"x")
    await adb.connect()
    assert runner.calls[0] == CONNECT
    assert runner.executables == {str(exe)}


async def test_the_icon_tool_resolves_aapt2_lazily(tmp_path: Path) -> None:
    exe = tmp_path / "aapt2.exe"
    seen: list[str] = []

    async def runner(argv: Any, seconds: float) -> AdbOutput:
        seen.append(argv[0])
        return AdbOutput(0, "package: name='x'")

    inspector = Aapt2Inspector(lambda: exe if exe.is_file() else None, runner=runner)
    with pytest.raises(IconToolError):
        await inspector.dump_badging(tmp_path / "app.apk")
    exe.write_bytes(b"x")
    assert await inspector.dump_badging(tmp_path / "app.apk") == "package: name='x'"
    assert seen == [str(exe)]


class FakeTime:
    """Relógio e `sleep` falsos: cada espera avança o relógio e devolve a vez ao laço."""

    def __init__(self, stop_after: int | None = None) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []
        self.stop_after = stop_after
        self.enough = asyncio.Event()

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        if self.stop_after is not None and len(self.sleeps) >= self.stop_after:
            self.enough.set()
        await asyncio.sleep(0)


async def test_failed_provisioning_backs_off_and_never_spins(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    exe = tmp_path / "adb.exe"
    clock = FakeTime()
    attempts: list[float] = []

    async def install() -> Path:
        attempts.append(clock.now)
        if len(attempts) == 3:
            # A terceira tentativa "dá certo".
            exe.write_bytes(b"x")
            return exe
        raise ProvisionError("o adb baixado não está assinado pela Google")

    watch = ToolWatch(
        "adb",
        lambda: exe if exe.is_file() else None,
        install,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
        recheck_seconds=60,
        first_delay_seconds=20,
        backoff_seconds=(300, 900),
    )
    with caplog.at_level(logging.WARNING):
        await asyncio.wait_for(watch.run(), 5)
    assert watch.state == READY
    # Primeira tentativa depois da espera inicial; as seguintes, depois de cada espera crescente.
    assert attempts == [20, 320, 1220]
    # Entre as tentativas só há esperas do intervalo de procura: nenhuma volta sem espera.
    assert clock.sleeps[0] == 20
    assert set(clock.sleeps[1:]) == {60}
    assert len(clock.sleeps) == 1 + (300 // 60) + (900 // 60)
    assert "não está assinado pela Google" in caplog.text
    assert "nova tentativa em 5 min" in caplog.text
    assert str(tmp_path) not in caplog.text


async def test_a_metered_network_postpones_without_downloading() -> None:
    clock = FakeTime(stop_after=12)
    installs: list[int] = []

    async def install() -> Path:
        installs.append(1)
        raise AssertionError("não devia baixar em rede tarifada")

    async def metered() -> str:
        return "rede tarifada (o download fica para uma rede sem limite)"

    watch = ToolWatch(
        "aapt2",
        lambda: None,
        install,
        network_block=metered,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
        recheck_seconds=60,
        first_delay_seconds=0,
        backoff_seconds=(300,),
    )
    task = asyncio.create_task(watch.run())
    await asyncio.wait_for(clock.enough.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert installs == []
    assert watch.state == FAILED
    assert "rede tarifada" in watch.status_line()


async def test_background_provisioning_does_not_block_the_event_loop(tmp_path: Path) -> None:
    google = FakeGoogle({PLATFORM_TOOLS_URL: platform_tools_zip()})
    target = provisioned_adb(tmp_path)
    watch = ToolWatch(
        "adb",
        lambda: target if target.is_file() else None,
        installer(tmp_path, google).install_adb,
        recheck_seconds=0.01,
        first_delay_seconds=0,
    )
    beats = 0
    stop = asyncio.Event()

    async def heartbeat() -> None:
        nonlocal beats
        while not stop.is_set():
            beats += 1
            await asyncio.sleep(0)

    beating = asyncio.create_task(heartbeat())
    await asyncio.wait_for(watch.run(), 10)
    stop.set()
    await beating
    assert watch.path() == provisioned_adb(tmp_path)
    # O laço seguiu atendendo outras tarefas enquanto o pacote era baixado e extraído.
    assert beats > 1


def test_configured_paths_and_the_owner_switch_turn_the_download_off(tmp_path: Path) -> None:
    assert not adb_watch(str(tmp_path / "adb.exe"), tmp_path).can_provision
    assert not aapt2_watch(str(tmp_path / "aapt2.exe"), tmp_path).can_provision
    assert not adb_watch(None, tmp_path, download=False).can_provision
    assert "desligado" in adb_watch(None, tmp_path, download=False).status_line()


# --- composição: o canal nasce sem `adb` e a capacidade chega quando ele aparece --------------


async def test_the_adb_capability_arrives_when_the_tool_shows_up_after_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    monkeypatch.delenv("UNIOVER_ADB_PATH")
    monkeypatch.setenv("PATH", str(tmp_path / "sem-nada-no-path"))
    # O download fica "permitido" (como no Windows), mas a tarefa de fundo não roda no teste.
    monkeypatch.setattr(android_tools, "_download_allowed", lambda configured, enabled: True)
    adapters: list[tuple[Any, ...]] = []
    fake = FakeTvAdb()

    def fake_adapter(*args: Any, **kwargs: Any) -> FakeTvAdb:
        adapters.append(args)
        return fake

    monkeypatch.setattr(tv_module, "AdbTv", fake_adapter)
    with caplog.at_level(logging.WARNING):
        setup = make_tv(Settings(tv_host=TV_HOST, tv_watchdog=False))
    assert setup is not None
    assert "adb não encontrado" in caplog.text
    assert "download da Google" in caplog.text
    assert "tv.apps.refresh.v1" in setup.handlers
    owners = [getattr(task, "__self__", None) for task in setup.background]
    watches = [owner for owner in owners if isinstance(owner, ToolWatch)]
    adb_tool = next(watch for watch in watches if watch.label == "adb")
    # O caminho vai preguiçoso ao canal: é o próprio vigia quem o resolve a cada comando.
    assert adapters[0][0] == adb_tool.path
    for step in setup.prepare:
        await step()
    assert "tv.adb" not in setup.capabilities

    exe = provisioned_adb(installation_base())
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"x")
    assert adb_tool.refresh() == exe
    assert "tv.adb" in setup.capabilities
    assert "tv.livre.v1" in setup.capabilities
