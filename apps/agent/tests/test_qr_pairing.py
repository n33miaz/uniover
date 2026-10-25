"""QR do pareamento: o desenho tem de ser exatamente a matriz do link, nos dois alfabetos."""

import io
from pathlib import Path

import pytest
import segno

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore
from uniover_agent.adapters.pairing_page import (
    connected_page_html,
    failed_page_html,
    pairing_page_html,
    write_connected_page,
    write_pairing_page,
)
from uniover_agent.adapters.qr_terminal import (
    render_ascii,
    render_blocks,
    render_for,
    supports_blocks,
)
from uniover_agent.config import connection_page_path
from uniover_agent.main import approval_link, main
from uniover_agent.ports import PairingDenied, PairingExpired, PairingTicket

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


def test_pairing_page_contains_only_the_public_link_and_code() -> None:
    device_code = "CODIGO-DO-APARELHO-SECRETO"
    page = pairing_page_html(LINK, "ABCD-2345")
    assert LINK in page
    assert "ABCD-2345" in page
    assert device_code not in page
    assert TOKEN not in page
    assert "data:image/svg+xml" in page
    assert "<script" not in page


def test_pairing_page_is_light_dark_and_keeps_the_qr_on_white() -> None:
    page = pairing_page_html(LINK, "ABCD-2345")
    assert "prefers-color-scheme: dark" in page
    assert "#ffffff" in page
    assert "Aprovar neste computador" in page
    assert "http://" not in page.replace(LINK, "")


def test_waiting_page_reloads_itself_to_show_the_outcome() -> None:
    page = pairing_page_html(LINK, "ABCD-2345")
    assert '<meta http-equiv="refresh" content="3">' in page


def test_success_and_failure_pages_never_reload() -> None:
    for page in (connected_page_html(), failed_page_html()):
        assert "http-equiv" not in page
        assert "refresh" not in page


def test_approve_here_is_the_main_action_above_the_qr_and_keeps_the_page_open() -> None:
    page = pairing_page_html(LINK, "ABCD-2345")
    link = page.index(f'href="{LINK}"')
    assert 'class="approve"' in page[link - 40 : link + 10]
    assert page.index("Aprovar neste computador") < page.index("<img")
    # Abre em outra aba: a de espera continua aqui para mostrar "PC conectado".
    assert 'target="_blank" rel="noopener"' in page


def test_the_page_is_replaced_whole_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    page = tmp_path / "web" / "conectar.html"
    write_pairing_page(page, LINK, "ABCD-2345")
    assert page.read_text(encoding="utf-8") == pairing_page_html(LINK, "ABCD-2345")
    write_connected_page(page)
    assert page.read_text(encoding="utf-8") == connected_page_html()
    assert [item.name for item in page.parent.iterdir()] == ["conectar.html"]


def test_the_page_is_still_written_when_the_swap_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_: object) -> None:
        raise PermissionError("arquivo em uso")

    monkeypatch.setattr("uniover_agent.adapters.pairing_page.os.replace", refuse)
    page = tmp_path / "conectar.html"
    write_connected_page(page)
    assert page.read_text(encoding="utf-8") == connected_page_html()
    assert [item.name for item in tmp_path.iterdir()] == ["conectar.html"]


def test_connection_page_sits_next_to_the_config_file(isolated_env: Path) -> None:
    assert connection_page_path() == isolated_env.parent / "conectar.html"


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
    assert "Escaneie com o celular de quem administra o UniOver" in out
    drawing = "\n".join(line for line in out.splitlines() if line and line[0] in "▀▄█")
    expected = expected_matrix(approval_link(api.url, "ABCD-2345"))
    assert parse_blocks(drawing)[: len(expected)] == expected
    assert TOKEN not in out
    page = connection_page_path().read_text(encoding="utf-8")
    assert "PC conectado. Pode fechar esta janela." in page
    assert "ABCD-2345" not in page
    assert TOKEN not in page


def test_pair_no_browser_never_opens_the_page(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[Path] = []
    monkeypatch.setattr(main_module, "can_open_browser", lambda: True)
    monkeypatch.setattr(main_module, "open_connection_page", opened.append)
    monkeypatch.setattr(main_module, "SystemClock", FakeClock)
    with FakePairingApi() as api:
        monkeypatch.setenv("UNIOVER_API_URL", api.url)
        monkeypatch.setenv("UNIOVER_ALLOW_INSECURE", "1")
        assert main(["pair", "--no-browser"], secrets=FakeSecretStore()) == 0
    assert opened == []


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


@pytest.mark.parametrize("failure", [PairingExpired, PairingDenied])
def test_pair_rewrites_the_page_when_the_code_expires_or_is_denied(
    monkeypatch: pytest.MonkeyPatch, failure: type[Exception]
) -> None:
    class FailingPairAgent:
        def __init__(self, *_: object) -> None:
            pass

        async def __call__(self, _info: object, show: object) -> None:
            show(PairingTicket("id", "CODIGO-DO-APARELHO-SECRETO", "ABCD-2345", 600, 1))  # type: ignore[operator]
            assert "ABCD-2345" in connection_page_path().read_text(encoding="utf-8")
            raise failure

    monkeypatch.setattr(main_module, "PairAgent", FailingPairAgent)
    monkeypatch.setenv("UNIOVER_API_URL", "https://uniover.onrender.com")
    assert main(["pair", "--no-browser"], secrets=FakeSecretStore()) == 1
    page = connection_page_path().read_text(encoding="utf-8")
    assert "rode o conector de novo" in page
    assert "ABCD-2345" not in page
    assert "CODIGO-DO-APARELHO-SECRETO" not in page
