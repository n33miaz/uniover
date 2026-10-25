"""Higienização do registro antes de sair do PC: nenhum segredo sai pela manutenção remota.

A higienização vem **antes** de qualquer corte por tamanho: um segredo partido ao meio pelo corte
não casaria mais com os padrões e escaparia.
"""

import re
from collections.abc import Iterable
from typing import Final

REDACTED: Final = "[removido]"
# Alfabeto do código curto de pareamento (sem vogais nem caracteres ambíguos).
_USER_CODE_ALPHABET: Final = "BCDFGHJKLMNPQRSTVWXZ2-9"
_MIN_KNOWN_SECRET_LENGTH: Final = 8

_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
# O cabeçalho inteiro: o esquema (`Basic`, `Bearer`, `Token`) e o valor vão juntos.
_AUTHORIZATION = re.compile(r"(?i)\b(authorization|proxy-authorization)\b([\"']?\s*[:=]\s*).*")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
_DEVICE_TOKEN = re.compile(r"\buo_dev_[A-Za-z0-9_-]+")
_KEYED = re.compile(
    r"(?i)(?<![A-Za-z0-9])"
    r"((?:access|refresh|id|device|api|auth|bearer|session|client)[_-]?(?:token|key|secret|code)"
    r"|token|password|passwd|pwd|senha|secret|credential|passkey|codigo|user[_-]?code|pairing[_-]?code)"
    r"([\"']?\s*[:=]\s*)"
    r"(?!\[removido\])"
    r"(\"[^\"]*\"|'[^']*'|[^\s&,;\"'}\]]+)"
)
# Código curto de pareamento solto no texto (ABCD-EFGH).
_USER_CODE = re.compile(
    rf"(?<![A-Za-z0-9-])[{_USER_CODE_ALPHABET}]{{4}}-[{_USER_CODE_ALPHABET}]{{4}}(?![A-Za-z0-9-])"
)
# `deviceCode` do pareamento: 32 bytes em base64url, sem preenchimento (43 caracteres).
_DEVICE_CODE = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")


def _keep_key(match: re.Match[str]) -> str:
    """Mantém o nome do campo e o separador; só o valor some."""
    return f"{match.group(1)}{match.group(2)}{REDACTED}"


def redact_line(line: str, secrets: Iterable[str] = ()) -> str:
    """Troca por `[removido]` o que parece segredo; os `secrets` conhecidos saem por igualdade."""
    # Primeiro os valores exatos que o agente conhece: valem mesmo sem nenhuma palavra-chave perto.
    for secret in secrets:
        if len(secret) >= _MIN_KNOWN_SECRET_LENGTH:
            line = line.replace(secret, REDACTED)
    line = _AUTHORIZATION.sub(_keep_key, line)
    line = _BEARER.sub(f"Bearer {REDACTED}", line)
    line = _JWT.sub(REDACTED, line)
    line = _DEVICE_TOKEN.sub(REDACTED, line)
    line = _KEYED.sub(_keep_key, line)
    line = _USER_CODE.sub(REDACTED, line)
    return _DEVICE_CODE.sub(REDACTED, line)


def redact(lines: Iterable[str], secrets: Iterable[str] = ()) -> list[str]:
    known = [secret for secret in secrets if secret]
    return [redact_line(line, known) for line in lines]
