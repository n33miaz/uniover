# ruff: noqa: E501 - scripts de PowerShell em texto
"""Instalador: a pasta escolhida, o ponteiro, o comentário do zip e os textos que a pessoa lê.

As funções vêm do próprio `install-windows.ps1` (pela árvore sintática) e rodam no Windows PowerShell 5.1.
A pasta fixa é uma pasta temporária do teste: nada toca a instalação real nem a tarefa agendada, e a janela
de escolha de pasta (`Select-InstallFolder`) nunca abre aqui (um substituto só conta as chamadas).
"""

import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest

INSTALLER = Path(__file__).parents[1] / "tools" / "install-windows.ps1"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
POWERSHELL = SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
pytestmark = pytest.mark.skipif(not POWERSHELL.is_file(), reason="precisa do Windows")

SHA = "c" * 40
FUNCTIONS = (
    "Set-Layout",
    "Get-ExistingBase",
    "Write-InstallLog",
    "Test-InstallFolder",
    "Resolve-InstallFolder",
    "Initialize-InstallFolder",
    "Get-ZipComment",
)

PRELUDE = r"""
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:UNIOVER_TEST_INSTALLER, [ref]$tokens, [ref]$errors)
foreach ($name in $env:UNIOVER_TEST_FUNCTIONS.Split(',')) {
    $found = $ast.Find({ param($node) ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($node.Name -eq $name) }, $true)
    Invoke-Expression $found.Extent.Text
}
$anchor = $env:UNIOVER_TEST_ANCHOR
$pointerFile = Join-Path $anchor 'location.txt'
Set-Layout $anchor
$InstallDir = $env:UNIOVER_TEST_INSTALLDIR
$automatic = ($env:UNIOVER_TEST_AUTOMATIC -eq '1')
$existingBase = $env:UNIOVER_TEST_EXISTING
if (-not $existingBase) { $existingBase = $null }
$script:dialogs = 0
# A janela de escolha de pasta nunca abre no teste: este substituto so conta as chamadas.
function Select-InstallFolder { $script:dialogs++; return $null }
function Out-Result([string]$Text) {
    [System.IO.File]::WriteAllText($env:UNIOVER_TEST_OUT, $Text, [System.Text.UTF8Encoding]::new($false))
}
"""


@pytest.fixture
def short(tmp_path: Path) -> Iterator[Path]:
    """Pasta curta (o limite do instalador para o caminho é de 80 caracteres; a do pytest passa disso)."""
    # `resolve` troca o nome curto 8.3 (NOME~1) do usuario pelo longo, que e o que o PowerShell devolve.
    root = Path(tempfile.mkdtemp(prefix="uo")).resolve()
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def run(  # noqa: PLR0913 - cada argumento é um ingrediente do cenário
    work: Path,
    body: str,
    *,
    anchor: Path | None = None,
    install_dir: str | None = None,
    existing: Path | None = None,
    automatic: bool = True,
    path: str = "",
) -> tuple[subprocess.CompletedProcess[str], Path]:
    out = work / "saida.txt"
    script = work / "ensaio.ps1"
    script.write_text(PRELUDE + body, encoding="ascii")
    environment = os.environ | {
        "UNIOVER_TEST_INSTALLER": str(INSTALLER),
        "UNIOVER_TEST_FUNCTIONS": ",".join(FUNCTIONS),
        "UNIOVER_TEST_ANCHOR": str(anchor or work / "fixa"),
        "UNIOVER_TEST_INSTALLDIR": install_dir or "",
        "UNIOVER_TEST_EXISTING": str(existing) if existing else "",
        "UNIOVER_TEST_AUTOMATIC": "1" if automatic else "0",
        "UNIOVER_TEST_PATH": path,
        "UNIOVER_TEST_OUT": str(out),
    }
    done = subprocess.run(  # noqa: S603 - Windows PowerShell do sistema e script do próprio teste
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
    )
    return done, out


def result(out: Path) -> str:
    return out.read_text(encoding="utf-8") if out.exists() else ""


CHECK = """
try { Test-InstallFolder $env:UNIOVER_TEST_PATH; Out-Result 'OK' } catch { Out-Result $_.Exception.Message }
"""


def test_a_short_local_folder_is_accepted_and_created(short: Path) -> None:
    target = short / "UniOver"
    done, out = run(short, CHECK, path=str(target))
    assert done.returncode == 0, done.stderr
    assert result(out) == "OK"
    assert target.is_dir()
    assert not (target / ".escrita").exists()


def test_a_network_folder_is_refused_with_a_plain_sentence(short: Path) -> None:
    done, out = run(short, CHECK, path=r"\\servidor\pasta\UniOver")
    assert done.returncode == 0, done.stderr
    assert "disco do proprio computador" in result(out)


def test_a_folder_inside_program_files_is_refused(short: Path) -> None:
    done, out = run(short, CHECK, path=os.path.join(os.environ["ProgramFiles"], "UniOver"))
    assert done.returncode == 0, done.stderr
    assert "protege" in result(out)


def test_a_path_longer_than_eighty_characters_is_refused(short: Path) -> None:
    long_path = short / ("x" * 70) / "UniOver"
    assert len(str(long_path)) > 80
    done, out = run(short, CHECK, path=str(long_path))
    assert done.returncode == 0, done.stderr
    assert "longo demais" in result(out)
    assert not long_path.exists()


def test_a_folder_that_cannot_be_written_is_refused(short: Path) -> None:
    blocker = short / "UniOver"
    blocker.write_text("sou um arquivo, nao uma pasta", encoding="utf-8")
    done, out = run(short, CHECK, path=str(blocker))
    assert done.returncode == 0, done.stderr
    assert "gravar" in result(out)


def test_the_chosen_folder_always_gets_its_own_uniover_subfolder(short: Path) -> None:
    body = """
$one = Resolve-InstallFolder $env:UNIOVER_TEST_PATH
$two = Resolve-InstallFolder ($env:UNIOVER_TEST_PATH + '\\UniOver')
$three = Resolve-InstallFolder ('"' + $env:UNIOVER_TEST_PATH + '"')
Out-Result ($one + '|' + $two + '|' + $three)
"""
    chosen = short / "Programas"
    done, out = run(short, body, path=str(chosen))
    assert done.returncode == 0, done.stderr
    expected = str(chosen / "UniOver")
    assert result(out) == f"{expected}|{expected}|{expected}"


def test_choosing_the_fixed_folder_itself_is_the_default_and_needs_no_checks(short: Path) -> None:
    anchor = short / "UniOver"
    body = "Out-Result (Resolve-InstallFolder $anchor)"
    done, out = run(short, body, anchor=anchor)
    assert done.returncode == 0, done.stderr
    assert result(out) == str(anchor)


def test_a_first_install_with_a_folder_writes_the_utf8_pointer_and_moves_everything_there(
    short: Path,
) -> None:
    anchor = short / "fixa" / "UniOver"
    anchor.parent.mkdir()
    chosen = short / "Pasta Ação"
    body = "Initialize-InstallFolder; Out-Result ($base + '|' + $script:dialogs)"
    done, out = run(short, body, anchor=anchor, install_dir=str(chosen))
    assert done.returncode == 0, done.stderr
    final = chosen / "UniOver"
    assert result(out) == f"{final}|0"  # com a pasta dada, a janela nem abre
    raw = (anchor / "location.txt").read_bytes()
    assert raw == str(final).encode("utf-8")  # UTF-8 sem BOM, o caminho com acento intacto
    assert final.is_dir()


def test_choosing_the_same_path_as_the_fixed_folder_writes_no_pointer(short: Path) -> None:
    anchor = short / "UniOver"
    body = "Initialize-InstallFolder; Out-Result $base"
    done, out = run(short, body, anchor=anchor, install_dir=str(anchor))
    assert done.returncode == 0, done.stderr
    assert result(out) == str(anchor)
    assert not (anchor / "location.txt").exists()


def test_a_reinstall_keeps_the_existing_folder_and_writes_no_pointer(short: Path) -> None:
    anchor = short / "UniOver"
    existing = short / "Antiga" / "UniOver"
    existing.mkdir(parents=True)
    body = "Set-Layout $existingBase; Initialize-InstallFolder; Out-Result ($base + '|' + $script:dialogs)"
    done, out = run(short, body, anchor=anchor, install_dir=str(short / "Nova"), existing=existing)
    assert done.returncode == 0, done.stderr
    assert result(out) == f"{existing}|0"
    assert not (anchor / "location.txt").exists()
    assert not (short / "Nova").exists()
    log = (existing / "logs" / "instalacao.log").read_text(encoding="utf-8")
    assert "foi mantida" in log


def test_without_a_folder_the_automatic_install_asks_once_and_cancelling_uses_the_default(
    short: Path,
) -> None:
    anchor = short / "UniOver"
    body = "Initialize-InstallFolder; Out-Result ($base + '|' + $script:dialogs)"
    done, out = run(short, body, anchor=anchor, automatic=True)
    assert done.returncode == 0, done.stderr
    assert result(out) == f"{anchor}|1"
    assert not (anchor / "location.txt").exists()


def test_the_manual_install_never_asks_and_uses_the_default_without_a_folder(short: Path) -> None:
    anchor = short / "UniOver"
    body = "Initialize-InstallFolder; Out-Result ($base + '|' + $script:dialogs)"
    done, out = run(short, body, anchor=anchor, automatic=False)
    assert done.returncode == 0, done.stderr
    assert result(out) == f"{anchor}|0"


def test_a_refused_folder_stops_the_install_before_any_pointer_is_written(short: Path) -> None:
    anchor = short / "UniOver"
    body = """
try { Initialize-InstallFolder; Out-Result 'seguiu' } catch { Out-Result $_.Exception.Message }
"""
    done, out = run(short, body, anchor=anchor, install_dir=os.environ["ProgramFiles"])
    assert done.returncode == 0, done.stderr
    assert "protege" in result(out)
    assert not (anchor / "location.txt").exists()


def test_an_existing_install_is_found_by_the_pointer_or_by_the_old_layouts(short: Path) -> None:
    anchor = short / "UniOver"
    anchor.mkdir()
    chosen = short / "Escolhida"
    chosen.mkdir()
    body = "Out-Result ([string](Get-ExistingBase))"

    # Primeira instalação: nada na pasta fixa.
    done, out = run(short, body, anchor=anchor)
    assert done.returncode == 0, done.stderr
    assert result(out) == ""

    # Ponteiro para uma pasta que existe.
    (anchor / "location.txt").write_text(str(chosen), encoding="utf-8")
    done, out = run(short, body, anchor=anchor)
    assert result(out) == str(chosen)

    # Ponteiro que aponta para o nada vale como ausente.
    (anchor / "location.txt").write_text(str(short / "sumiu"), encoding="utf-8")
    done, out = run(short, body, anchor=anchor)
    assert result(out) == ""

    # Instalação já feita na pasta fixa (com ou sem o layout antigo `agent-src`).
    (anchor / "app").mkdir()
    done, out = run(short, body, anchor=anchor)
    assert result(out) == str(anchor)
    (anchor / "app").rmdir()
    (anchor / "agent-src").mkdir()
    done, out = run(short, body, anchor=anchor)
    assert result(out) == str(anchor)


def _zip(path: Path, comment: bytes | None) -> None:
    with zipfile.ZipFile(path, "w") as bundle:
        if comment is not None:
            bundle.comment = comment
        bundle.writestr("uniover/a.txt", "x" * 100)


READ_COMMENT = """
$value = Get-ZipComment $env:UNIOVER_TEST_PATH
if ($null -eq $value) { Out-Result 'NULO' } else { Out-Result ('[' + $value + ']') }
"""


def test_the_zip_comment_is_read_from_the_end_of_the_file(short: Path) -> None:
    package = short / "pacote.zip"
    _zip(package, SHA.encode("ascii"))
    done, out = run(short, READ_COMMENT, path=str(package))
    assert done.returncode == 0, done.stderr
    assert result(out) == f"[{SHA}]"


def test_a_zip_without_a_comment_gives_an_empty_one(short: Path) -> None:
    package = short / "pacote.zip"
    _zip(package, None)
    done, out = run(short, READ_COMMENT, path=str(package))
    assert done.returncode == 0, done.stderr
    assert result(out) == "[]"


def test_a_truncated_or_non_zip_file_has_no_comment_at_all(short: Path) -> None:
    package = short / "pacote.zip"
    _zip(package, SHA.encode("ascii"))
    cut = short / "cortado.zip"
    cut.write_bytes(package.read_bytes()[:-30])
    done, out = run(short, READ_COMMENT, path=str(cut))
    assert done.returncode == 0, done.stderr
    assert result(out) == "NULO"
    other = short / "texto.zip"
    other.write_text("isto nao e um zip", encoding="utf-8")
    done, out = run(short, READ_COMMENT, path=str(other))
    assert result(out) == "NULO"
    done, out = run(short, READ_COMMENT, path=str(short / "nao-existe.zip"))
    assert result(out) == "NULO"


# --- O que a pessoa lê ---------------------------------------------------------------------------------------------

JARGON = re.compile(
    r"\b(uv|winget|python|venv|agente|qr|sha|commit)\b|tarefa agendada", re.IGNORECASE
)
LITERAL = re.compile(r"'((?:[^']|'')*)'|\"([^\"]*)\"")


def _visible_strings() -> list[str]:
    """Os textos de tela e de erro do instalador (a parte comum e o modo automático), não os do terminal manual."""
    text = INSTALLER.read_text(encoding="utf-8").replace("\r\n", "\n")
    text = text[: text.index("# --- Modo manual")]
    found: list[str] = []
    lines = text.splitlines()
    inside_summary = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if "$summary = @(" in stripped:
            inside_summary = True
        elif inside_summary and stripped == ")":
            inside_summary = False
        speaks = (
            stripped.startswith(("Write-Page", "Write-Host", "throw ")) or "{ throw" in stripped
        )
        speaks = speaks or "Write-Page (" in stripped
        if speaks or inside_summary:
            found.extend(first or second for first, second in LITERAL.findall(line))
    return found


def test_the_texts_the_person_reads_have_no_jargon() -> None:
    strings = _visible_strings()
    assert len(strings) > 15, "o filtro deixou de achar os textos do instalador"
    offenders = [text for text in strings if JARGON.search(text)]
    assert offenders == []


def test_the_folder_dialog_is_gentle_and_never_blocks_the_install() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    dialog = text[
        text.index("function Select-InstallFolder") : text.index(
            "function Initialize-InstallFolder"
        )
    ]
    assert "FolderBrowserDialog" in dialog
    assert "[regex]::Unescape" in dialog  # o arquivo e ASCII: os acentos vao por escape
    assert "catch { }" in dialog and dialog.rstrip().endswith("return $null\n}".rstrip())
    assert (
        dialog.count("return $null") == 1
    )  # cancelar ou falhar devolve `$null`: usa a pasta padrao


def test_the_zip_comment_is_checked_before_anything_is_extracted() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    fetch = text[text.index("function Get-AgentSource") :]
    assert fetch.index("Get-ZipComment $zip") < fetch.index("ExtractToFile")


def test_the_install_uses_locked_dependencies_and_checks_the_version_before_going_on() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    assert "sync --locked --project $source" in text
    assert "uniover_agent.selfcheck" in text
    automatic = text[
        text.index("function Invoke-AutomaticInstall") : text.index("# --- Modo manual")
    ]
    assert automatic.index("Invoke-Prepare $uv") < automatic.index("Invoke-SelfCheck $uv")
    assert automatic.index("Initialize-InstallFolder") < automatic.index("Open-Page")
