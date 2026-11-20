"""Fluxo de conexão do PC: páginas com o mesmo visual no instalador e no agente, etapas, uv e
adb achados sozinhos e a TV Android pareada pelo celular (sem janela no PC)."""

import ast
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from uniover_agent.adapters.pairing_page import (
    LOGO_SVG,
    PAGE_STYLE,
    STEPS,
    failed_page_html,
    pairing_page_html,
    progress_page_html,
    step_states,
)
from uniover_agent.composition import tv as tv_module
from uniover_agent.composition.system import EXIT_TV_CODE_ON_PHONE
from uniover_agent.composition.tv import tv_pair
from uniover_agent.config import Settings, tv_cert_dir

from .support_tv import write_certificate

TOOLS = Path(__file__).parents[1] / "tools"
INSTALLER = TOOLS / "install-windows.ps1"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
LINK = "https://uniover.onrender.com/ajustes/dispositivos?codigo=ABCD-2345"


def _installer_style() -> str:
    text = INSTALLER.read_text(encoding="ascii")
    block = text[text.index("$pageStyle = @(") + len("$pageStyle = @(") : text.index(") -join ''")]
    return "".join(re.findall(r"'([^']*)'", block))


def _installer_steps() -> list[tuple[str, str]]:
    text = INSTALLER.read_text(encoding="ascii")
    block = text[text.index("$pageSteps = @(") : text.index("$stepStateText")]
    return re.findall(r"@\('([a-z]+)', '([^']+)'\)", block)


def test_installer_and_agent_pages_share_the_exact_same_style_and_steps() -> None:
    assert _installer_style() == PAGE_STYLE
    assert _installer_steps() == list(STEPS)
    assert PAGE_STYLE.isascii()
    assert "'" not in PAGE_STYLE  # cabe numa string de aspas simples do PowerShell sem escape


# O símbolo do app (o mesmo da tela de entrar e do favicon): quadrado verde, ponto e duas ondas.
_LOGO_PARTS = (
    'viewBox="0 0 512 512"',
    '<rect width="512" height="512" rx="112" fill="#3B6B4B"/>',
    '<circle cx="256" cy="256" r="70" fill="#FFFFFF" stroke="none"/>',
    '<path d="M362.1 149.9A150 150 0 0 1 362.1 362.1"/>',
    '<path d="M149.9 149.9A150 150 0 0 0 149.9 362.1"/>',
)


def _installer_logo() -> str:
    text = INSTALLER.read_text(encoding="ascii")
    found: list[str] = re.findall(r"^\$logoSvg = '([^']*)'$", text, flags=re.MULTILINE)
    return found[0]


def test_the_pages_show_the_real_app_logo_instead_of_a_plain_square() -> None:
    logo_rule = PAGE_STYLE.split(".logo{", 1)[1].split("}", 1)[0]
    assert "background" not in logo_rule, "nada de quadrado liso pintado pelo CSS"
    for page in (pairing_page_html(LINK, "ABCD2345"), failed_page_html()):
        brand = page[page.index('<p class="brand">') : page.index("UniOver</p>")]
        assert '<svg class="logo"' in brand and 'aria-hidden="true"' in brand
        for part in _LOGO_PARTS:
            assert part in brand
    logo = _installer_logo()
    assert logo == LOGO_SVG
    assert logo.isascii()
    for part in _LOGO_PARTS:
        assert part in logo
    installer = INSTALLER.read_text(encoding="ascii")
    assert """'<p class="brand">' + $logoSvg + 'UniOver</p>'""" in installer
    assert '<span class="logo"' not in installer


def test_the_style_follows_the_app_palette_in_light_and_dark() -> None:
    # Mesmas cores de apps/web/src/styles.css (verde-sálvia), nos dois temas.
    for color in ("#f2f5f1", "#3b6b4b", "#17201a", "#101512", "#98c4a3", "#e9efea"):
        assert color in PAGE_STYLE
    assert "prefers-color-scheme: dark" in PAGE_STYLE
    assert "prefers-reduced-motion: reduce" in PAGE_STYLE
    assert "focus-visible" in PAGE_STYLE


def test_steps_before_the_current_are_done_and_after_it_are_next() -> None:
    assert step_states("tv") == [
        ("prepare", "done"),
        ("phone", "done"),
        ("tv", "now"),
        ("ready", "todo"),
    ]
    assert step_states("phone", failed=True)[1] == ("phone", "fail")
    assert {state for _, state in step_states(None)} == {"done"}


def test_pages_are_accessible_and_phone_friendly() -> None:
    for page in (
        pairing_page_html(LINK, "ABCD-2345", installing=True),
        progress_page_html("Procurando a TV…", "tv"),
        failed_page_html(),
    ):
        assert '<html lang="pt-BR">' in page
        assert 'name="viewport" content="width=device-width, initial-scale=1"' in page
        assert 'role="status"' in page
        assert "<script" not in page
    steps = pairing_page_html(LINK, "ABCD-2345", installing=True)
    assert 'aria-label="Etapas"' in steps
    assert '<span class="sr"> (agora)</span>' in steps
    assert 'alt="QR para aprovar este PC no UniOver pelo celular"' in steps
    assert 'aria-label="Etapas"' not in pairing_page_html(LINK, "ABCD-2345")


def test_failed_page_never_reloads_and_says_what_to_do() -> None:
    page = failed_page_html()
    assert "refresh" not in page
    assert 'class="lead bad"' in page
    assert "Abra o conector de novo" in page


async def test_android_tv_without_pairing_is_left_for_the_phone(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def never(*args: object) -> None:
        raise AssertionError("não deveria contatar a TV nem pedir código no PC")

    monkeypatch.setattr(tv_module, "pair_tv", never)
    code = await tv_pair(
        Settings(tv_host="192.168.0.4"), None, None, if_needed=True, code_on_phone=True
    )
    assert code == EXIT_TV_CODE_ON_PHONE
    assert "celular" in capsys.readouterr().out


async def test_an_already_paired_android_tv_still_counts_as_paired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def never(*args: object) -> None:
        raise AssertionError("não deveria parear de novo")

    monkeypatch.setattr(tv_module, "pair_tv", never)
    write_certificate(tv_cert_dir("tv"), "UniOver")
    code = await tv_pair(
        Settings(tv_host="192.168.0.4"), None, None, if_needed=True, code_on_phone=True
    )
    assert code == 0


def test_the_automatic_installer_reads_the_tv_pairing_outcome_by_exit_code() -> None:
    text = INSTALLER.read_text(encoding="ascii")
    assert f"{EXIT_TV_CODE_ON_PHONE} {{ 'phone' }}" in text


def test_the_tv_code_window_is_no_longer_used_by_the_automatic_installer() -> None:
    main = (Path(__file__).parents[1] / "src" / "uniover_agent" / "main.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(main)
    flags = {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_argument"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    }
    assert "--code-on-phone" in flags


# --- uv e adb achados sem o PATH novo (PowerShell de verdade, funções extraídas do instalador) ----

FUNCTIONS = ("Find-UvExecutable", "Find-AdbExecutable", "Update-ProcessPath", "Get-ConfigValue")
PRELUDE = r"""
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$parser = [System.Management.Automation.Language.Parser]
$ast = $parser::ParseFile($env:UNIOVER_TEST_INSTALLER, [ref]$tokens, [ref]$errors)
foreach ($name in $env:UNIOVER_TEST_FUNCTIONS.Split(',')) {
    $kind = [System.Management.Automation.Language.FunctionDefinitionAst]
    $found = $ast.Find({ param($node) ($node -is $kind) -and ($node.Name -eq $name) }, $true)
    Invoke-Expression $found.Extent.Text
}
$base = $env:UNIOVER_TEST_BASE
function Out-Result([string]$Text) {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($env:UNIOVER_TEST_OUT, $Text, $utf8)
}
"""


@pytest.fixture
def short() -> Iterator[Path]:
    root = Path(tempfile.mkdtemp(prefix="uo")).resolve()
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(work: Path, body: str) -> str:
    script = work / "ensaio.ps1"
    out = work / "saida.txt"
    script.write_text(PRELUDE + body, encoding="ascii")
    # PATH mínimo (sem uv nem adb) e LOCALAPPDATA/USERPROFILE falsos: nada da máquina real entra.
    environment = os.environ | {
        "UNIOVER_TEST_INSTALLER": str(INSTALLER),
        "UNIOVER_TEST_FUNCTIONS": ",".join(FUNCTIONS),
        "UNIOVER_TEST_BASE": str(work / "UniOver"),
        "UNIOVER_TEST_OUT": str(out),
        "LOCALAPPDATA": str(work / "local"),
        "USERPROFILE": str(work / "perfil"),
        "PATH": str(SYSTEM32) + ";" + str(POWERSHELL.parent),
    }
    done = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema e script do próprio teste
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
        creationflags=0x08000000,
    )
    assert done.returncode == 0, done.stderr or done.stdout
    return out.read_text(encoding="utf-8") if out.exists() else ""


windows_only = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")


@windows_only
def test_uv_freshly_installed_by_winget_is_found_without_a_new_terminal(short: Path) -> None:
    package = (
        short
        / "local"
        / "Microsoft"
        / "WinGet"
        / "Packages"
        / "astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe"
    )
    package.mkdir(parents=True)
    (package / "uv.exe").write_bytes(b"MZ")
    found = _run(short, "Out-Result ([string](Find-UvExecutable))")
    assert found == str(package / "uv.exe")


@windows_only
def test_uv_from_the_official_installer_is_found_in_the_user_profile(short: Path) -> None:
    local_bin = short / "perfil" / ".local" / "bin"
    local_bin.mkdir(parents=True)
    (local_bin / "uv.exe").write_bytes(b"MZ")
    assert _run(short, "Out-Result ([string](Find-UvExecutable))") == str(local_bin / "uv.exe")


@windows_only
def test_no_uv_anywhere_gives_nothing(short: Path) -> None:
    assert _run(short, "Out-Result ([string](Find-UvExecutable))") == ""


@windows_only
def test_adb_is_found_in_the_uniover_folder_and_in_the_winget_package(short: Path) -> None:
    package = (
        short
        / "local"
        / "Microsoft"
        / "WinGet"
        / "Packages"
        / "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe"
        / "platform-tools"
    )
    package.mkdir(parents=True)
    (package / "adb.exe").write_bytes(b"MZ")
    assert _run(short, "Out-Result ([string](Find-AdbExecutable))") == str(package / "adb.exe")
    mine = short / "UniOver" / "tools" / "platform-tools"
    mine.mkdir(parents=True)
    (mine / "adb.exe").write_bytes(b"MZ")
    assert _run(short, "Out-Result ([string](Find-AdbExecutable))") == str(mine / "adb.exe")


@windows_only
def test_the_tv_kind_saved_by_tv_find_is_read_back(short: Path) -> None:
    config = short / "agent.toml"
    config.write_text('api_url = "https://x"\ntv_kind = "samsung"\n', encoding="utf-8")
    body = f"Out-Result ([string](Get-ConfigValue '{config}' 'tv_kind'))"
    assert _run(short, body) == "samsung"
