"""Ferramentas dos ícones: localizar o `aapt2`, ler o ZIP, cache em disco, pasta temporária."""

import os
import stat
import sys
import tempfile
import zipfile
from collections.abc import Sequence
from pathlib import Path

import pytest

from uniover_agent.adapters.apk_tools import (
    Aapt2Inspector,
    FileIconCache,
    TempApkScratch,
    default_icons_dir,
    locate_aapt2,
)
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.ports import AppIcon, CachedIcon, IconToolError

from .support_icons import png_bytes, webp_bytes

EXE = "aapt2.exe" if sys.platform == "win32" else "aapt2"


def fake_sdk(root: Path, *versions: str) -> None:
    for version in versions:
        tool = root / "Android" / "Sdk" / "build-tools" / version / EXE
        tool.parent.mkdir(parents=True)
        tool.write_text("x")


# --- localizar o aapt2 --------------------------------------------------------------------------


def test_the_configured_path_wins_when_it_exists(tmp_path: Path) -> None:
    tool = tmp_path / EXE
    tool.write_text("x")
    assert locate_aapt2(str(tool)) == tool


def test_a_configured_path_that_does_not_exist_does_not_fall_back_to_the_sdk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    fake_sdk(tmp_path / "local", "35.0.0")
    assert locate_aapt2(str(tmp_path / "nao-existe" / EXE)) is None


def test_the_newest_build_tools_version_wins_comparing_numbers_not_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    fake_sdk(tmp_path / "local", "9.0.0", "34.0.0", "36.1.0", "36.0.0", "35.0.0")
    found = locate_aapt2(None)
    assert found is not None
    assert found.parent.name == "36.1.0"


def test_without_an_sdk_there_is_no_aapt2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "vazio"))
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    assert locate_aapt2(None) is None


def test_android_home_is_also_searched(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "vazio"))
    sdk = tmp_path / "sdk"
    tool = sdk / "build-tools" / "34.0.0" / EXE
    tool.parent.mkdir(parents=True)
    tool.write_text("x")
    monkeypatch.setenv("ANDROID_HOME", str(sdk))
    assert locate_aapt2(None) == tool


# --- aapt2 e leitura do ZIP ---------------------------------------------------------------------


class Runner:
    def __init__(self, reply: AdbOutput | BaseException) -> None:
        self.reply = reply
        self.calls: list[tuple[Sequence[str], float]] = []

    async def __call__(self, argv: Sequence[str], seconds: float) -> AdbOutput:
        self.calls.append((list(argv), seconds))
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply


async def test_dump_badging_runs_aapt2_without_a_shell_and_with_a_timeout(tmp_path: Path) -> None:
    runner = Runner(AdbOutput(0, "package: name='a.b' versionCode='1'\n"))
    inspector = Aapt2Inspector(Path("aapt2-falso"), timeout=12.0, runner=runner)
    apk = tmp_path / "app.apk"
    text = await inspector.dump_badging(apk)
    assert "versionCode='1'" in text
    assert runner.calls == [(["aapt2-falso", "dump", "badging", str(apk)], 12.0)]


async def test_dump_resources_keeps_the_file_lines_so_it_never_uses_no_values(
    tmp_path: Path,
) -> None:
    # `--no-values` tiraria as linhas `(file)`, de onde sai o ícone legado do ícone adaptativo.
    runner = Runner(AdbOutput(0, "Package name=a.b id=7f\n"))
    inspector = Aapt2Inspector(Path("aapt2-falso"), timeout=12.0, runner=runner)
    apk = tmp_path / "app.apk"
    assert "a.b" in await inspector.dump_resources(apk)
    assert runner.calls == [(["aapt2-falso", "dump", "resources", str(apk)], 12.0)]


@pytest.mark.parametrize("what", ["dump_badging", "dump_resources"])
@pytest.mark.parametrize(
    "reply",
    [AdbOutput(1, "ERROR: dump failed"), TimeoutError(), FileNotFoundError(), PermissionError()],
)
async def test_aapt2_failures_become_one_tool_error_with_a_fixed_message(
    reply: AdbOutput | BaseException, what: str, tmp_path: Path
) -> None:
    inspector = Aapt2Inspector(Path("segredo/aapt2"), runner=Runner(reply))
    with pytest.raises(IconToolError) as caught:
        await getattr(inspector, what)(tmp_path / "x.apk")
    assert "segredo" not in str(caught.value)
    assert str(tmp_path) not in str(caught.value)


def make_apk(path: Path, members: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return path


async def test_only_the_wanted_member_is_read_from_the_zip(tmp_path: Path) -> None:
    apk = make_apk(tmp_path / "a.apk", {"res/Ec.png": png_bytes(), "res/outro.bin": b"x" * 10})
    inspector = Aapt2Inspector(Path("x"))
    assert await inspector.read_member(apk, "res/Ec.png", 32768) == png_bytes()
    assert await inspector.read_member(apk, "res/nao-tem.png", 32768) is None
    # Nada foi extraído para o disco ao lado do APK.
    assert sorted(path.name for path in tmp_path.iterdir()) == ["a.apk"]  # noqa: ASYNC240


async def test_a_member_larger_than_the_limit_is_never_loaded(tmp_path: Path) -> None:
    apk = make_apk(tmp_path / "a.apk", {"res/big.png": png_bytes(pad_to=5000)})
    inspector = Aapt2Inspector(Path("x"))
    assert await inspector.read_member(apk, "res/big.png", 1000) is None
    assert await inspector.read_member(apk, "res/big.png", 10_000) is not None


async def test_a_directory_entry_is_not_an_image(tmp_path: Path) -> None:
    apk = make_apk(tmp_path / "a.apk", {"res/": b""})
    assert await Aapt2Inspector(Path("x")).read_member(apk, "res/", 100) is None


async def test_a_corrupt_or_missing_apk_is_a_tool_error(tmp_path: Path) -> None:
    broken = tmp_path / "quebrado.apk"
    broken.write_bytes(b"isto nao e um zip")
    inspector = Aapt2Inspector(Path("x"))
    with pytest.raises(IconToolError):
        await inspector.read_member(broken, "res/a.png", 100)
    with pytest.raises(IconToolError):
        await inspector.read_member(tmp_path / "sumiu.apk", "res/a.png", 100)


# --- cache em disco -----------------------------------------------------------------------------


def test_the_default_cache_folder_is_under_the_user_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert default_icons_dir() == tmp_path / "local" / "UniOver" / "icons"


def test_cache_round_trip_for_png_and_webp(tmp_path: Path) -> None:
    cache = FileIconCache(tmp_path / "icons")
    assert cache.load("com.a.b", 3) is None
    cache.store("com.a.b", 3, AppIcon("image/png", png_bytes()))
    assert cache.load("com.a.b", 3) == CachedIcon(AppIcon("image/png", png_bytes()))
    cache.store("com.c.d", 1, AppIcon("image/webp", webp_bytes()))
    assert cache.load("com.c.d", 1) == CachedIcon(AppIcon("image/webp", webp_bytes()))
    assert (tmp_path / "icons" / "com.a.b-3.r2.png").is_file()


def test_the_no_icon_marker_is_remembered(tmp_path: Path) -> None:
    cache = FileIconCache(tmp_path)
    cache.store("com.a.b", 3, None)
    assert cache.load("com.a.b", 3) == CachedIcon(None)
    assert (tmp_path / "com.a.b-3.r2.none").is_file()


def test_a_new_version_deletes_the_old_files_of_that_package_only(tmp_path: Path) -> None:
    cache = FileIconCache(tmp_path)
    cache.store("com.a.b", 1, AppIcon("image/png", png_bytes()))
    cache.store("com.a.b2", 1, AppIcon("image/png", png_bytes()))
    cache.store("com.a.b", 2, AppIcon("image/webp", webp_bytes()))
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "com.a.b-2.r2.webp",
        "com.a.b2-1.r2.png",
    ]
    assert cache.load("com.a.b", 1) is None


def test_same_version_with_another_type_replaces_the_entry(tmp_path: Path) -> None:
    cache = FileIconCache(tmp_path)
    cache.store("com.a.b", 1, AppIcon("image/png", png_bytes()))
    cache.store("com.a.b", 1, None)
    assert [path.name for path in tmp_path.iterdir()] == ["com.a.b-1.r2.none"]


def test_entries_written_by_an_older_selection_rule_are_ignored_and_then_replaced(
    tmp_path: Path,
) -> None:
    # Antes da regra do quadrado o cache guardava o banner (e "sem ícone" para quem só tinha XML).
    # Nada disso pode valer: o app tem de ser resolvido de novo pela regra atual.
    (tmp_path / "com.cnvs.apptv-50.png").write_bytes(png_bytes(32, 18))
    (tmp_path / "com.a.b-7.none").write_bytes(b"")
    cache = FileIconCache(tmp_path)
    assert cache.load("com.cnvs.apptv", 50) is None
    assert cache.load("com.a.b", 7) is None
    cache.store("com.cnvs.apptv", 50, AppIcon("image/webp", webp_bytes(192)))
    cache.store("com.a.b", 7, None)
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "com.a.b-7.r2.none",
        "com.cnvs.apptv-50.r2.webp",
    ]


@pytest.mark.parametrize("package", ["../fora", "a/b.c", "com.a b.c", "", "sem_ponto"])
def test_the_cache_refuses_package_names_that_could_escape_the_folder(
    package: str, tmp_path: Path
) -> None:
    cache = FileIconCache(tmp_path)
    with pytest.raises(ValueError, match="inválidos"):
        cache.load(package, 1)
    with pytest.raises(ValueError, match="inválidos"):
        cache.store(package, 1, None)


def test_an_unsupported_mime_is_not_cached(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="tipo de imagem"):
        FileIconCache(tmp_path).store("com.a.b", 1, AppIcon("image/gif", b"GIF89a"))


def test_a_cache_folder_that_cannot_be_written_only_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "arquivo"
    blocker.write_text("x")  # uma pasta não pode ser criada onde já existe um arquivo
    FileIconCache(blocker / "icons").store("com.a.b", 1, AppIcon("image/png", png_bytes()))
    assert "cache" in caplog.text


@pytest.mark.skipif(sys.platform == "win32", reason="permissão de leitura é do POSIX")
def test_an_unreadable_cache_file_is_treated_as_missing(tmp_path: Path) -> None:
    cache = FileIconCache(tmp_path)
    cache.store("com.a.b", 1, AppIcon("image/png", png_bytes()))
    target = tmp_path / "com.a.b-1.r2.png"
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip("executando como superusuário")
        assert cache.load("com.a.b", 1) is None
    finally:
        target.chmod(stat.S_IRUSR | stat.S_IWUSR)


# --- pasta temporária ---------------------------------------------------------------------------


def test_scratch_gives_unique_apk_paths_and_discards_them(tmp_path: Path) -> None:
    scratch = TempApkScratch(tmp_path / "tmp")
    first, second = scratch.new_path(), scratch.new_path()
    assert first != second
    assert first.suffix == ".apk"
    assert first.parent == tmp_path / "tmp"
    first.write_bytes(b"x")
    scratch.discard(first)
    assert not first.exists()
    scratch.discard(first)  # apagar o que não existe nunca levanta


def test_scratch_purge_removes_leftovers_from_a_crashed_run(tmp_path: Path) -> None:
    folder = tmp_path / "tmp"
    scratch = TempApkScratch(folder)
    scratch.new_path()
    (folder / "sobra.apk").write_bytes(b"x")
    (folder / "outro.txt").write_text("fica")
    scratch.purge()
    assert [path.name for path in folder.iterdir()] == ["outro.txt"]
    TempApkScratch(tmp_path / "nunca-criada").purge()  # sem pasta: nada a fazer


def test_scratch_defaults_to_the_user_temp_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    path = TempApkScratch().new_path()
    assert path.parent == tmp_path / "uniover-agent-apk"
    assert path.parent.is_dir()
