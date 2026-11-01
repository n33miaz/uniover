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


# --- Dados pessoais: do diagnóstico sai só o necessário para entender a falha ------------------

PATH_MARK: Final = "<caminho>"
IP_MARK: Final = "<ip>"
MAC_MARK: Final = "<mac>"
EMAIL_MARK: Final = "<email>"
NAME_MARK: Final = "<nome>"
_MIN_NAME_LENGTH: Final = 3

# Caminho do Windows (`C:\Users\fulano\...`), de rede (`\\servidor\pasta`) e de usuário em Unix. O
# caminho inteiro some: ele quase sempre leva o nome do usuário ou do PC.
# Pastas podem ter espaço no nome (`C:\Users\Jane Doe\...`): as pastas do caminho consomem palavras
# separadas por um espaço enquanto houver barra adiante, e o fim leva as palavras até a primeira
# que termina em extensão ou, sem extensão (`C:\Users\Jane Doe`), até o delimitador seguinte (`:`,
# `,`, `;`, parêntese, aspas) ou o fim da linha. Sem isso o caminho parava no primeiro espaço e o
# resto do nome do usuário seguia para a API; engolir um pouco de texto a mais é o lado seguro.
_SEGMENT = r"[^\\/\s\"'<>|*?:,;()]"
_PATH_TAIL = (
    rf"(?:{_SEGMENT}+(?: {_SEGMENT}+)*[\\/])*"
    rf"(?:{_SEGMENT}+?(?: {_SEGMENT}+)*?\.[A-Za-z0-9]{{1,8}}(?![A-Za-z0-9])"
    rf"|(?:{_SEGMENT}+(?: {_SEGMENT}+)*)?)"
)
_WINDOWS_PATH = re.compile(rf"(?<![A-Za-z0-9])[A-Za-z]:[\\/]{_PATH_TAIL}")
_NETWORK_PATH = re.compile(rf"\\\\{_SEGMENT}+[\\/]{_PATH_TAIL}|\\\\{_SEGMENT}+")
_UNIX_HOME = re.compile(rf"(?<![A-Za-z0-9_.-])/(?:home|Users|root)/{_PATH_TAIL}")
_IPV4 = re.compile(
    r"(?<![0-9.])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?![0-9])"
)
_IPV6 = re.compile(r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])")
_MAC = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}(?![0-9A-Fa-f])")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def scrub_personal(text: str, names: Iterable[str] = ()) -> str:
    """Tira de `text` segredos, caminhos, endereços de rede, e-mails e os `names` conhecidos.

    `names` são o nome do usuário do Windows e o do computador, que o agente conhece e que podem
    aparecer soltos em mensagens de erro de bibliotecas. Serve ao que vai para a API: o registro
    local continua inteiro.
    """
    text = redact_line(text)
    text = _WINDOWS_PATH.sub(PATH_MARK, text)
    text = _NETWORK_PATH.sub(PATH_MARK, text)
    text = _UNIX_HOME.sub(PATH_MARK, text)
    text = _EMAIL.sub(EMAIL_MARK, text)
    text = _MAC.sub(MAC_MARK, text)
    text = _IPV4.sub(IP_MARK, text)
    text = _IPV6.sub(IP_MARK, text)
    for name in names:
        if len(name) >= _MIN_NAME_LENGTH:
            text = re.sub(rf"(?i)(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", NAME_MARK, text)
    return text
