"""Caminhos com espaço no nome não podem deixar pedaço do nome do usuário ir para a API."""

import pytest

from uniover_agent.core.redaction import PATH_MARK, scrub_personal


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            r"Erro ao abrir C:\Users\Jane Doe\segredo.txt: acesso negado",
            f"Erro ao abrir {PATH_MARK}: acesso negado",
        ),
        (
            r"falha em C:\Users\Jane Doe\Meus Documentos\relatorio final.pdf (linha 3)",
            f"falha em {PATH_MARK} (linha 3)",
        ),
        (
            r"sem acesso a \\servidor\pasta compartilhada\Jane Doe\x.txt agora",
            f"sem acesso a {PATH_MARK} agora",
        ),
        ("/home/Jane Doe/arquivo secreto.txt falhou", f"{PATH_MARK} falhou"),
        (r"caminho 'C:\Users\Jane Doe\a.txt' inválido", f"caminho '{PATH_MARK}' inválido"),
        (r"copiou C:\a\b e seguiu", f"copiou {PATH_MARK} e seguiu"),
        (r"pasta C:\Users\Jane Doe\AppData\Local\UniOver\app", f"pasta {PATH_MARK}"),
    ],
)
def test_a_path_with_spaces_is_removed_whole(text: str, expected: str) -> None:
    cleaned = scrub_personal(text)
    assert cleaned == expected
    assert "Doe" not in cleaned
