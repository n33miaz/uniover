"""Composição do agente e comandos de linha: `run` (padrão), `pair` e `status`."""

import argparse
import asyncio
import logging
import platform
import random
import re
import socket
import sys
from collections.abc import Callable, Sequence
from importlib import metadata

from uniover_agent.adapters.local_config import save_agent_config
from uniover_agent.adapters.pairing_http import HttpPairingClient, probe_api
from uniover_agent.adapters.secret_store_keyring import KeyringSecretStore, SecretStoreError
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.transport_ws import WebSocketTransport, build_ws_url
from uniover_agent.config import ConfigError, Settings, config_path, require_api_url
from uniover_agent.core import (
    ConnectionSupervisor,
    EnvelopeFactory,
    EnvelopeGate,
    HandleCommand,
    PairAgent,
    ProcessMessage,
)
from uniover_agent.ports import (
    Clock,
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingTicket,
    SecretStore,
)

_log = logging.getLogger("uniover_agent")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_NOT_PAIRED = 2
EXIT_CREDENTIAL_REJECTED = 3

_NOT_PAIRED = "não pareado. Rode `uniover-agent pair` para parear este PC."


def agent_version() -> str:
    try:
        return metadata.version("uniover-agent")
    except metadata.PackageNotFoundError:
        return "0.0.0"


def silence_noisy_loggers() -> None:
    """Em DEBUG essas bibliotecas registram cabeçalhos (inclusive `Authorization`) e corpos:
    ficam em WARNING sempre, para que nenhum segredo chegue ao registro."""
    for noisy in ("websockets", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True
    )
    silence_noisy_loggers()


def build_handler(clock: Clock) -> HandleCommand:
    """Comandos que este agente sabe executar. Sem aparelhos habilitados, nenhum: todo comando
    é recusado e registrado (nada finge que apertou uma tecla)."""
    # [composição: aparelhos] os handlers de TV entram aqui, junto das capacidades declaradas.
    return HandleCommand({}, clock)


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


async def pair(settings: Settings, open_store: StoreFactory, name: str | None) -> int:
    api_url = require_api_url(settings)
    use_case = PairAgent(HttpPairingClient(api_url), open_store(), SystemClock())

    def show(ticket: PairingTicket) -> None:
        print(f"\nCódigo de pareamento: {ticket.user_code}")
        print(
            f"Abra o app ({api_url}) e aprove este código em até {ticket.expires_in // 60} minutos."
        )
        print("Aguardando a aprovação...")

    try:
        paired = await use_case(pairing_info(name), show)
    except PairingExpired:
        print("O código venceu. Rode `uniover-agent pair` de novo.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingDenied:
        print("O pareamento foi recusado no app.", file=sys.stderr)
        return EXIT_FAILURE
    except PairingError as exc:
        print(f"Falha no pareamento: {exc}", file=sys.stderr)
        return EXIT_FAILURE

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


async def run(settings: Settings, open_store: StoreFactory) -> int:
    agent_id = settings.agent_id
    if not agent_id:
        print(_NOT_PAIRED, file=sys.stderr)
        return EXIT_NOT_PAIRED
    secrets = open_store()
    if secrets.get(agent_id) is None:
        print(_NOT_PAIRED, file=sys.stderr)
        return EXIT_NOT_PAIRED
    api_url = require_api_url(settings)

    clock = SystemClock()
    gate = EnvelopeGate(agent_id)
    envelopes = EnvelopeFactory(agent_id, gate, clock)
    transport = WebSocketTransport(
        build_ws_url(api_url, agent_id),
        lambda: secrets.get(agent_id),
        user_agent=f"uniover-agent/{agent_version()}",
    )
    process = ProcessMessage(agent_id, gate, build_handler(clock), envelopes, transport)
    supervisor = ConnectionSupervisor(
        transport,
        process,
        envelopes,
        clock,
        random.SystemRandom().random,
        agent_version=agent_version(),
        capabilities=(),
    )
    _log.info("agente %s iniciando (api %s)", agent_id, api_url)
    await supervisor.run()
    # `run` só devolve quando a credencial foi recusada; o token continua no cofre.
    print(
        "Token revogado ou inválido. Rode `uniover-agent pair` para parear de novo.",
        file=sys.stderr,
    )
    return EXIT_CREDENTIAL_REJECTED


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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="uniover-agent", description="Agente local do UniOver.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="conecta à API e roda em primeiro plano (padrão)")
    pair_parser = sub.add_parser("pair", help="pareia este PC com um código curto")
    pair_parser.add_argument("--name", help="nome do agente (padrão: nome do computador)")
    sub.add_parser("status", help="mostra se há token e se a API responde")
    return parser


def main(argv: Sequence[str] | None = None, *, secrets: SecretStore | None = None) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    try:
        settings = Settings()
        configure_logging(settings.log_level)

        def open_store() -> SecretStore:
            # O cofre só é aberto quando o comando precisa dele.
            return secrets or KeyringSecretStore()

        if command == "pair":
            return asyncio.run(pair(settings, open_store, args.name))
        if command == "status":
            return asyncio.run(status(settings, open_store))
        return asyncio.run(run(settings, open_store))
    except (ConfigError, SecretStoreError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        print("Encerrado.")
        return EXIT_OK
