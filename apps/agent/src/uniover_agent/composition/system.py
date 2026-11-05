"""Versão, sistema operacional, log e códigos de saída do agente."""

import logging
import platform
import re
import sys
from importlib import metadata
from logging.handlers import RotatingFileHandler
from pathlib import Path

from uniover_agent.adapters.self_update import read_version
from uniover_agent.config import agent_source_dir

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_NOT_PAIRED = 2
EXIT_CREDENTIAL_REJECTED = 3
# A TV mudou de endereço: `main` recomeça o `run` já com o endereço novo.
EXIT_TV_MOVED = 4
_NOT_PAIRED = "não pareado. Rode `uniover-agent pair` para parear este PC."


def agent_version() -> str:
    try:
        return metadata.version("uniover-agent")
    except metadata.PackageNotFoundError:
        return "0.0.0"


_BUILD_DIGITS = 12


def build_version() -> str:
    """Versão SemVer do produto e, quando se sabe, o commit instalado (`0.5.0+3f2a9c1d4e5b`).

    É o que a tela do dono mostra: o número identifica a publicação e o commit diz de fato qual
    código está rodando. O arquivo `.version` é o que a auto-atualização grava e compara.
    """
    version = agent_version()
    try:
        commit = read_version(agent_source_dir())
    except OSError:
        commit = None
    if commit and re.fullmatch(r"[0-9a-f]{7,40}", commit):
        return f"{version}+{commit[:_BUILD_DIGITS]}"
    return version


def describe_os() -> str | None:
    """Sistema do PC para a tela do dono (ex.: `Windows 11 (10.0.26200)`); nunca falha."""
    try:
        system, release, version = platform.system(), platform.release(), platform.version()
    except OSError:
        return None
    text = f"{system} {release} ({version})" if version else f"{system} {release}"
    return text.strip()[:80] or None


def silence_noisy_loggers() -> None:
    """Em DEBUG essas bibliotecas registram cabeçalhos (inclusive `Authorization`) e corpos:
    ficam em WARNING sempre, para que nenhum segredo chegue ao registro. A `androidtvremote2`
    também registra o que envia à TV e o código de pareamento."""
    for noisy in ("websockets", "httpx", "httpcore", "androidtvremote2", "samsungtvws"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def configure_logging(level: str, log_file: str | None = None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        # A tarefa do Windows roda sem janela: o arquivo é o único lugar onde o dono (ou quem o
        # ajuda) vê o que o agente fez. Rodízio de 1 MB com 2 cópias: nunca enche o disco.
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            handlers.append(
                RotatingFileHandler(log_file, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
            )
        except OSError:
            print("Aviso: não consegui abrir o arquivo de registro.", file=sys.stderr)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )
    silence_noisy_loggers()
