"""Pareamento do agente com a API e o comando `status`."""

import logging
import platform
import re
import socket
import sys
from collections.abc import Callable
from pathlib import Path
from urllib.parse import quote

from uniover_agent.adapters.local_config import save_agent_config
from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
from uniover_agent.adapters.pairing_page import (
    can_open_browser,
    open_connection_page,
    write_connected_page,
    write_failed_page,
    write_pairing_page,
    write_progress_page,
)
from uniover_agent.adapters.qr_terminal import render_ascii, render_for
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.composition.system import _NOT_PAIRED, EXIT_FAILURE, EXIT_OK, agent_version
from uniover_agent.config import Settings, config_path, connection_page_path, require_api_url
from uniover_agent.core import PairAgent
from uniover_agent.ports import (
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingTicket,
    SecretStore,
)

_log = logging.getLogger("uniover_agent")


def _sanitize(text: str, pattern: str, limit: int, fallback: str) -> str:
    cleaned = re.sub(pattern, "-", text).strip(" ._-()")[:limit].strip()
    return cleaned or fallback


def pairing_info(name: str | None) -> PairingInfo:
    """Nome, plataforma e versão no alfabeto e tamanho que a API aceita."""
    host = name or socket.gethostname()
    return PairingInfo(
        agent_name=_sanitize(host, r"[^\w ._()-]", 60, "agente"),
        platform=_sanitize(
            f"{platform.system()} {platform.release()}", r"[^A-Za-z0-9._ -]", 30, "pc"
        ),
        agent_version=_sanitize(agent_version(), r"[^A-Za-z0-9.+_-]", 30, "0.0.0"),
    )


StoreFactory = Callable[[], SecretStore]


def approval_link(api_url: str, user_code: str) -> str:
    """Link que abre a aprovação do dispositivo já com o código preenchido."""
    return f"{api_url}/ajustes/dispositivos?codigo={quote(user_code)}"


def print_qr(link: str) -> None:
    """Imprime o QR do link; falha de desenho é só um aviso (o código escrito basta)."""
    try:
        try:
            print(render_for(link))
        except UnicodeEncodeError:
            print(render_ascii(link))
    except Exception:
        _log.warning("não consegui desenhar o QR; use o código escrito")


def _update_page(write: Callable[[Path], None]) -> None:
    """Reescreve a página do QR; falha de disco é só um aviso."""
    try:
        write(connection_page_path())
    except OSError as exc:
        _log.warning("não consegui atualizar a página do QR (%s)", type(exc).__name__)


async def pair(  # noqa: PLR0913 - o instalador soma uma opção a cada passo
    settings: Settings,
    open_store: StoreFactory,
    name: str | None,
    *,
    if_needed: bool = False,
    no_browser: bool = False,
    installing: bool = False,
) -> int:
    api_url = require_api_url(settings)
    store = open_store()
    if if_needed and settings.agent_id and store.get(settings.agent_id) is not None:
        print("Este PC já está pareado com o UniOver.")
        return EXIT_OK
    use_case = PairAgent(HttpPairingClient(api_url), store, SystemClock())

    def show(ticket: PairingTicket) -> None:
        link = approval_link(api_url, ticket.user_code)
        print(f"\nCódigo de pareamento: {ticket.user_code}")
        print("\nEscaneie com o celular de quem administra o UniOver:\n")
        print_qr(link)
        try:
            page = connection_page_path()
            write_pairing_page(page, link, ticket.user_code)
            if not no_browser and can_open_browser():
                open_connection_page(page)
        except OSError as exc:
            _log.warning("não consegui preparar a página do QR (%s)", type(exc).__name__)
        print(
            f"\nOu abra o app ({api_url}) e aprove este código "
            f"em até {ticket.expires_in // 60} minutos."
        )
        print("Aguardando a aprovação...")

    try:
        paired = await use_case(pairing_info(name), show)
    except PairingExpired:
        _update_page(write_failed_page)
        print("O código venceu. Rode `uniover-agent pair` de novo.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingDenied:
        _update_page(write_failed_page)
        print("O pareamento foi recusado no app.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingError as exc:
        if connection_page_path().exists():
            _update_page(write_failed_page)
        print(f"Falha no pareamento: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    if installing:
        # O instalador ainda tem a TV e a tarefa pela frente e é ele quem escreve o "Pronto".
        _update_page(
            lambda page: write_progress_page(page, "PC conectado. Terminando a instalação…")
        )
    else:
        _update_page(write_connected_page)

    # O token já está no cofre; agora o `agentId` vai para a configuração local do usuário.
    try:
        save_agent_config(config_path(), api_url=api_url, agent_id=paired.agent_id)
    except OSError as exc:
        print(
            f"Pareado, mas não consegui gravar a configuração ({type(exc).__name__}). "
            f"Defina UNIOVER_AGENT_ID={paired.agent_id} e UNIOVER_API_URL.",
            file=sys.stderr,
        )
        return EXIT_FAILURE
    print(f"Pareado como '{paired.agent_id}'. Token guardado no cofre de credenciais.")
    print("Agora rode `uniover-agent run`.")
    return EXIT_OK


async def status(settings: Settings, open_store: StoreFactory) -> int:
    agent_id = settings.agent_id
    if not agent_id or open_store().get(agent_id) is None:
        print(_NOT_PAIRED)
        return EXIT_OK
    api_url = require_api_url(settings)
    print(f"Pareado como '{agent_id}'; token no cofre de credenciais.")
    # Não abre o canal do agente: uma segunda conexão derrubaria a do agente em execução.
    reachable = await probe_api(api_url)
    print(f"API {'alcançável' if reachable else 'sem resposta (pode estar acordando)'}: {api_url}")
    return EXIT_OK
