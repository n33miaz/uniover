"""Pareamento com a TV (código de 6 caracteres na tela) e a pasta protegida do certificado.

O par certificado/chave identifica este agente perante a TV: quem o tiver controla a TV. Por isso
fica fora do repositório, numa pasta que só o usuário do Windows lê, e nunca aparece em log nem em
mensagem de erro (o texto das exceções da biblioteca pode carregar o código de pareamento, então
nenhuma delas é repassada).
"""

import asyncio
import getpass
import logging
import os
import re
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Protocol

from androidtvremote2 import AndroidTVRemote, CannotConnect, ConnectionClosed, InvalidAuth

from uniover_agent.adapters.process import run_hidden
from uniover_agent.adapters.tv_remote_v2 import CERT_FILE, KEY_FILE

_log = logging.getLogger(__name__)

_CODE_PATTERN = re.compile(r"^[0-9A-Fa-f]{6}$")
_PRIVATE_DIR_MODE = 0o700


class TvPairingError(Exception):
    """Falha do pareamento; a mensagem já é para o usuário (sem segredo)."""


class PairingLibrary(Protocol):
    """O pedaço de `AndroidTVRemote` que o pareamento usa (permite um duplo nos testes)."""

    async def async_generate_cert_if_missing(self) -> bool: ...

    async def async_start_pairing(self) -> None: ...

    async def async_finish_pairing(self, pairing_code: str) -> None: ...

    def disconnect(self) -> None: ...


PairingFactory = Callable[[str, str, str, str], PairingLibrary]


def _default_factory(client_name: str, certfile: str, keyfile: str, host: str) -> PairingLibrary:
    return AndroidTVRemote(client_name, certfile, keyfile, host)


def restrict_to_current_user(directory: Path) -> None:
    """Deixa a pasta (e o que for criado dentro dela) legível só pelo usuário atual.

    Windows: `icacls` remove a herança e concede acesso total só ao usuário, com herança para os
    arquivos novos (por isso roda **antes** de a chave ser gerada). Outros sistemas: modo 0700.
    """
    if sys.platform != "win32":
        directory.chmod(_PRIVATE_DIR_MODE)
        return
    icacls = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "icacls.exe"
    grant = f"{getpass.getuser()}:(OI)(CI)F"
    try:
        run_hidden(
            [str(icacls), str(directory), "/inheritance:r", "/grant:r", grant],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise TvPairingError(
            f"não consegui restringir a permissão da pasta {directory} ao seu usuário"
        ) from exc


def prepare_private_dir(directory: Path) -> None:
    """Cria a pasta do certificado já restrita ao usuário (antes de qualquer arquivo nascer)."""
    directory.mkdir(parents=True, exist_ok=True)
    restrict_to_current_user(directory)


def _discard_pair(directory: Path) -> None:
    for name in (CERT_FILE, KEY_FILE):
        (directory / name).unlink(missing_ok=True)


def is_paired(cert_dir: Path) -> bool:
    """Há o par certificado/chave? (Não prova que a TV ainda o aceita: só a conexão prova.)"""
    return (cert_dir / CERT_FILE).is_file() and (cert_dir / KEY_FILE).is_file()


async def pair_tv(
    host: str,
    client_name: str,
    cert_dir: Path,
    ask_code: Callable[[], Awaitable[str]],
    *,
    factory: PairingFactory = _default_factory,
) -> None:
    """Gera o par (se faltar), pede o código mostrado na TV e conclui o pareamento."""
    await asyncio.to_thread(prepare_private_dir, cert_dir)
    client = factory(client_name, str(cert_dir / CERT_FILE), str(cert_dir / KEY_FILE), host)
    created = False
    try:
        created = await client.async_generate_cert_if_missing()
        if created:
            _log.info("certificado do cliente gerado em %s", cert_dir)
        try:
            await client.async_start_pairing()
        except CannotConnect, ConnectionClosed, OSError:
            raise TvPairingError(
                f"não consegui falar com a TV em {host}: confira o endereço e se ela está ligada"
            ) from None
        code = (await ask_code()).strip()
        if not _CODE_PATTERN.fullmatch(code):
            raise TvPairingError("o código tem 6 caracteres (0-9 e A-F), como aparece na TV")
        try:
            await client.async_finish_pairing(code)
        except InvalidAuth:
            raise TvPairingError("a TV não aceitou o código; rode o pareamento de novo") from None
        except ConnectionClosed:
            raise TvPairingError(
                "a TV fechou a conexão (pareamento cancelado ou demorou demais)"
            ) from None
    except BaseException:
        if created:
            # Par novo que a TV não aceitou: apagar evita declarar `tv.remote` sem estar pareado.
            _discard_pair(cert_dir)
        raise
    finally:
        client.disconnect()
