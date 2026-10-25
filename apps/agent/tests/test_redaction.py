"""Higienização do registro: nenhum segredo sai do PC pela manutenção remota."""

import pytest

from uniover_agent.core import redact, redact_line
from uniover_agent.core.redaction import REDACTED

from .support import TOKEN

# 32 bytes em base64url sem preenchimento: o formato do `deviceCode` do pareamento.
DEVICE_CODE = "kJ3xQ2mP9vLw8RtYb5NcZaHd6EfUgS1oIpXqVn7MrAs"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIzNDU2"


@pytest.mark.parametrize(
    ("line", "secret"),
    [
        ("GET /api com Authorization: Bearer abc.def-123_xyz", "abc.def-123_xyz"),
        ("headers={'Authorization': 'Basic dXNlcjpzZW5oYQ=='}", "dXNlcjpzZW5oYQ"),
        ("authorization=Token meu-segredo-qualquer", "meu-segredo-qualquer"),
        ("enviei bearer   AbCdEf.GhIjKl.MnOp", "AbCdEf.GhIjKl.MnOp"),
        (f"token expirou: {JWT}", JWT),
        (f"connect token={TOKEN}", TOKEN),
        (f'{{"deviceCode": "{DEVICE_CODE}", "pairingId": 7}}', DEVICE_CODE),
        (f"device_code={DEVICE_CODE}", DEVICE_CODE),
        (f"resposta cru {DEVICE_CODE} fim", DEVICE_CODE),
        ("access_token=zzz111zzz refresh_token: yyy222yyy", "zzz111zzz"),
        ("refresh_token: yyy222yyy", "yyy222yyy"),
        ('{"password":"senha-do-dono","user":"dono"}', "senha-do-dono"),
        ("senha=abracadabra123", "abracadabra123"),
        ("passwd: abracadabra123", "abracadabra123"),
        ("client_secret=shhh-nao-conte", "shhh-nao-conte"),
        ("abrindo https://uniover.example/aparelhos?codigo=BCDF-GH23 no navegador", "BCDF-GH23"),
        ("o código é BCDF-GH23, digite no site", "BCDF-GH23"),
        ("user_code=BCDF-GH23", "BCDF-GH23"),
    ],
)
def test_secrets_are_replaced(line: str, secret: str) -> None:
    result = redact_line(line)
    assert secret not in result
    assert REDACTED in result


def test_the_known_token_is_removed_even_without_a_keyword_next_to_it() -> None:
    line = f"valor solto {TOKEN} no meio"
    assert TOKEN not in redact_line(line, [TOKEN])
    assert redact_line(line, [TOKEN]) == f"valor solto {REDACTED} no meio"


def test_a_known_secret_that_is_too_short_to_be_one_is_ignored() -> None:
    # Um valor curtíssimo trocaria pedaços de palavras comuns por `[removido]`.
    assert redact_line("conexão aberta", ["ab"]) == "conexão aberta"


def test_the_field_name_stays_so_the_log_still_reads() -> None:
    assert redact_line("senha=abc123def") == f"senha={REDACTED}"
    assert redact_line('{"token": "abcdef123456"}') == f'{{"token": {REDACTED}}}'
    assert redact_line("Authorization: Bearer xyz") == f"Authorization: {REDACTED}"


def test_ordinary_lines_are_left_alone() -> None:
    lines = [
        "2026-10-24 14:00:00,000 INFO uniover_agent: conectado",
        "2026-10-24 14:00:01,000 WARNING uniover_agent.core.connection: conexão perdida (timeout)",
        "tv 192.168.0.20 respondeu em 12 ms; apps: 14; status=200 code=200",
        "agente pc-casa iniciando (api https://uniover.onrender.com)",
        "ABCD-EFGH-IJKL é só texto (as vogais não existem no alfabeto do código)",
    ]
    assert redact(lines) == lines


def test_every_line_is_cleaned_independently_and_in_order() -> None:
    lines = ["primeira", f"Authorization: Bearer {TOKEN}", "terceira"]
    assert redact(lines, [TOKEN]) == ["primeira", f"Authorization: {REDACTED}", "terceira"]


def test_the_cut_never_sees_an_unclean_line() -> None:
    # A higienização roda sobre a linha inteira; o corte vem depois (ver test_remote_care).
    long_line = "x" * 5000 + f" token={TOKEN}"
    assert TOKEN not in redact_line(long_line)
