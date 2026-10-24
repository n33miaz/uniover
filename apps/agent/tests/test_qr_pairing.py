"""QR do pareamento: o desenho tem de ser exatamente a matriz do link, nos dois alfabetos."""

import io
from pathlib import Path

import pytest
import segno

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.adapters.qr_terminal import (
    render_ascii,
    render_blocks,
    render_for,
    supports_blocks,
)
from uniover_agent.main import approval_link, main

from .support import TOKEN
from .test_config_main import FakePairingApi

LINK = "https://uniover.onrender.com/ajustes/dispositivos?codigo=ABCD-2345"
QUIET = 3


def expected_matrix(link: str) -> list[list[bool]]:
    """Módulos escuros do link, com a margem clara em volta."""
    matrix = [[bool(cell) for cell in row] for row in segno.make(link, error="m").matrix]
    width = len(matrix[0]) + 2 * QUIET
    margin = [[False] * width for _ in range(QUIET)]
    body = [[False] * QUIET + row + [False] * QUIET for row in matrix]
    return margin + body + margin


def parse_blocks(text: str) -> list[list[bool]]:
    """Desfaz o desenho de meios-blocos: preenchido é claro, vazio é escuro."""
    light = {"█": (True, True), "▀": (True, False), "▄": (False, True)}
    rows: list[list[bool]] = []
    for line in text.splitlines():
        top: list[bool] = []
        bottom: list[bool] = []
        for char in line:
            upper, lower = light.get(char, (False, False))
            top.append(not upper)
            bottom.append(not lower)
        rows += [top, bottom]
    return rows


def parse_ascii(text: str) -> list[list[bool]]:
    rows = []
    for line in text.splitlines():
        pairs = [line[i : i + 2] for i in range(0, len(line), 2)]
        rows.append([pair == "  " for pair in pairs])
    return rows


def test_block_drawing_is_the_exact_matrix_of_the_link() -> None:
    drawn = parse_blocks(render_blocks(LINK))
    expected = expected_matrix(LINK)
    # O desenho compacto completa com uma linha clara se o total de linhas é ímpar.
    assert drawn[: len(expected)] == expected
    assert all(not any(row) for row in drawn[len(expected) :])
    # Compacto de verdade: cabe em um console de 30 linhas.
    assert len(render_blocks(LINK).splitlines()) <= 22


def test_ascii_drawing_is_the_exact_matrix_of_the_link() -> None:
    assert parse_ascii(render_ascii(LINK)) == expected_matrix(LINK)
    assert render_ascii(LINK).isascii()


def test_light_modules_are_the_filled_ones_for_dark_terminals() -> None:
    # A margem é clara: a primeira linha do desenho é toda de blocos cheios.
    first = render_blocks(LINK).splitlines()[0]
    assert set(first) == {"█"}


class FakeStream(io.StringIO):
    def __init__(self, encoding: str) -> None:
        super().__init__()
        self._encoding = encoding

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return self._encoding


def test_blocks_are_used_only_when_the_console_can_write_them() -> None:
    utf8, cp1252 = FakeStream("utf-8"), FakeStream("cp1252")
    assert supports_blocks(utf8)
    assert not supports_blocks(cp1252)
    assert render_for(LINK, utf8) == render_blocks(LINK)
    ascii_drawing = render_for(LINK, cp1252)
    assert ascii_drawing == render_ascii(LINK)
    ascii_drawing.encode("cp1252")


def test_approval_link_carries_the_code_without_a_trailing_slash() -> None:
    assert approval_link("https://uniover.onrender.com", "ABCD-2345") == LINK


def test_pair_shows_the_code_the_qr_of_the_link_and_the_instruction(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    isolated_env: Path,
) -> None:
    with FakePairingApi() as api:
        monkeypatch.setenv("UNIOVER_API_URL", api.url)
        monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
        monkeypatch.setattr(main_module, "SystemClock", FakeClock)
        assert main(["pair"], secrets=FakeSecretStore()) == 0
        out = capsys.readouterr().out
    assert "ABCD-2345" in out
    assert "Escaneie com o celular onde você usa o UniOver" in out
    drawing = "\n".join(line for line in out.splitlines() if line and line[0] in "▀▄█")
    expected = expected_matrix(approval_link(api.url, "ABCD-2345"))
    assert parse_blocks(drawing)[: len(expected)] == expected
    assert TOKEN not in out


def test_pair_falls_back_to_ascii_when_the_console_cannot_write_blocks(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse(_link: str) -> str:
        raise UnicodeEncodeError("cp1252", "█", 0, 1, "sem glifo")

    monkeypatch.setattr(main_module, "render_for", refuse)
    main_module.print_qr(LINK)
    out = capsys.readouterr().out
    assert out.isascii()
    assert parse_ascii(out.rstrip("\n")) == expected_matrix(LINK)


def test_a_qr_failure_never_breaks_the_pairing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken(_link: str) -> str:
        raise RuntimeError("falha qualquer")

    monkeypatch.setattr(main_module, "render_for", broken)
    main_module.print_qr(LINK)
    assert capsys.readouterr().out == ""


def test_pair_if_needed_skips_an_already_paired_pc(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("UNIOVER_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
    monkeypatch.setenv("UNIOVER_AGENT_ID", "pc-da-sala")
    store = FakeSecretStore()
    store.set("pc-da-sala", TOKEN)
    assert main(["pair", "--if-needed"], secrets=store) == 0
    assert "já está pareado" in capsys.readouterr().out
