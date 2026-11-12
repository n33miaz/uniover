"""Ponto de entrada e orquestração de alto nível da linha de comando do agente."""

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Sequence

from pydantic import ValidationError

from uniover_agent.adapters import windows_scheduling
from uniover_agent.adapters.installation import legacy_wrapper_start, migrate_layout
from uniover_agent.adapters.secret_store_keyring import KeyringSecretStore, SecretStoreError
from uniover_agent.adapters.single_instance import (
    ALREADY_RUNNING_MESSAGE,
    EXIT_ALREADY_RUNNING,
    acquire,
)
from uniover_agent.adapters.startup_trace import (
    describe_exception,
    log_once,
    record_startup_failure,
    session_started,
)
from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tv_locate import identify_tv
from uniover_agent.adapters.tv_pairing import ask_code_in_window
from uniover_agent.care_setup import DiagnosticsKit, attach_log_handler, build_diagnostics
from uniover_agent.composition import connection, maintenance, pairing, pc, system, tv
from uniover_agent.config import ConfigError, Settings
from uniover_agent.ports import SecretStore


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="uniover-agent", description="Agente local do UniOver.")
    sub = parser.add_subparsers(dest="command")
    run_parser = sub.add_parser("run", help="conecta à API e roda em primeiro plano (padrão)")
    run_parser.add_argument(
        "--handover",
        action="store_true",
        help="chamado pelo supervisor: conecta com a versão anterior ainda servindo e a substitui",
    )
    pair_parser = sub.add_parser("pair", help="pareia este PC com um código curto")
    pair_parser.add_argument("--name", help="nome do agente (padrão: nome do computador)")
    pair_parser.add_argument(
        "--if-needed", action="store_true", help="não pareia de novo se este PC já está pareado"
    )
    pair_parser.add_argument(
        "--installing",
        action="store_true",
        help="chamado pelo instalador: a página segue em andamento depois do pareamento",
    )
    pair_parser.add_argument(
        "--no-browser", action="store_true", help="não abre a página local do QR no navegador"
    )
    sub.add_parser("status", help="mostra se há token e se a API responde")
    tv_parser = sub.add_parser("tv-pair", help="pareia o agente com a TV (código mostrado na tela)")
    tv_parser.add_argument("--kind", choices=("android", "samsung"), help="tipo da TV")
    tv_parser.add_argument("--host", help="endereço IP da TV (padrão: UNIOVER_TV_HOST)")
    tv_parser.add_argument("--name", help="nome da pasta do certificado (padrão: UNIOVER_TV_NAME)")
    tv_parser.add_argument(
        "--installing",
        action="store_true",
        help="chamado pelo instalador (sem console): o código da TV é pedido numa janela",
    )
    tv_parser.add_argument(
        "--if-needed", action="store_true", help="não pareia de novo uma TV que já está pareada"
    )
    find_parser = sub.add_parser(
        "tv-find", help="procura a TV na rede local e grava o endereço no agent.toml"
    )
    find_parser.add_argument("--kind", choices=("android", "samsung"), help="só este tipo de TV")
    update_parser = sub.add_parser(
        "self-update", help="atualiza o agente instalado se a versão pública mudou"
    )
    update_parser.add_argument(
        "--no-sync", action="store_true", help="não roda `uv sync` depois (o instalador faz)"
    )
    update_parser.add_argument(
        "--apply",
        action="store_true",
        help="troca para a versão já preparada (espera a TV e o PC ficarem parados)",
    )
    diagnose_parser = sub.add_parser(
        "diagnose", help="confere a saúde deste agente (pasta, início automático, API, TV)"
    )
    diagnose_parser.add_argument(
        "--repair", action="store_true", help="também aplica os reparos seguros que existirem"
    )
    sub.add_parser(
        "tv-volume", help="mostra por quais caminhos o agente consegue ler o volume da TV (só lê)"
    )
    pc_parser = sub.add_parser(
        "pc-control", help="liga ou desliga o controle deste PC pelo app (mouse, teclado, mídia)"
    )
    pc_parser.add_argument(
        "state", choices=("on", "off", "status"), help="`on` liga, `off` desliga, `status` mostra"
    )
    sub.add_parser("tray", help=argparse.SUPPRESS)
    return parser


class InvalidSettingsError(ConfigError):
    """A configuração recusada pelo pydantic; `fields` são os nomes dos campos (nunca valores)."""

    def __init__(self, message: str, fields: Sequence[str]) -> None:
        super().__init__(message)
        self.fields = tuple(fields)


def _load_settings() -> Settings:
    """`Settings()`, com a recusa do pydantic vista como erro de configuração.

    A mensagem do pydantic traz os valores recebidos, e eles podem ser segredos: só os nomes dos
    campos seguem adiante.
    """
    try:
        return Settings()
    except ValidationError as exc:
        fields = ", ".join(sorted({".".join(str(part) for part in e["loc"]) for e in exc.errors()}))
        raise InvalidSettingsError(
            f"configuração inválida ({fields})", fields.split(", ")
        ) from None


def _other_instance_owns() -> bool:
    """Pega a trava do agente desta instalação; `True` (e avisa, sem repetir) se já é de outro."""
    if acquire():
        return False
    print(f"Erro: {ALREADY_RUNNING_MESSAGE}", file=sys.stderr)
    log_once("ja_rodando", ALREADY_RUNNING_MESSAGE)
    return True


def _keep_responsive() -> None:
    """A tarefa agendada dá ao agente e a quem o vigia CPU, memória e E/S baixas: devolve ao
    normal. Uma falha aqui (ctypes, Windows antigo) nunca impede a partida."""
    try:
        windows_scheduling.keep_agent_responsive()
    except Exception:
        logging.getLogger("uniover_agent").warning(
            "não consegui devolver a prioridade do agente ao normal; sigo assim", exc_info=True
        )


def main(  # noqa: PLR0911, PLR0912 - um retorno por comando
    argv: Sequence[str] | None = None, *, secrets: SecretStore | None = None
) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    try:
        # Antes de qualquer acesso a arquivo do agente (a fila de diagnóstico é de um dono só): dois
        # agentes com a mesma identidade se derrubam no servidor.
        # O wrapper antigo que só entrega a instalação ao lançador novo (e sai) não toma a trava:
        # quem sabe disso é a migração, que só a seguir avisa por `UNIOVER_LEGACY_TAKEOVER`. Nesse
        # caso a trava é decidida depois dela; em todos os outros, antes.
        legacy = command == "run" and legacy_wrapper_start()
        # A execução de uma passagem sem queda convive com a anterior até ela sair: a trava é
        # tomada depois (`composition.connection`), quando a anterior a largar.
        handover = bool(getattr(args, "handover", False))
        if command == "run" and not legacy and not handover and _other_instance_owns():
            return EXIT_ALREADY_RUNNING
        # Também roda quando um wrapper antigo inicia o código novo pela primeira vez.
        migrate_layout()
        if legacy and not os.environ.get("UNIOVER_LEGACY_TAKEOVER") and _other_instance_owns():
            return EXIT_ALREADY_RUNNING
        settings = _load_settings()
        system.configure_logging(settings.log_level, settings.log_file)
        kit: DiagnosticsKit | None = None
        if command in {"run", "self-update"} and settings.self_care:
            # Daqui em diante, todo erro registrado vira também uma ocorrência de diagnóstico.
            kit = build_diagnostics(SystemClock())
            attach_log_handler(kit)

        def open_store() -> SecretStore:
            # O cofre só é aberto quando o comando precisa dele.
            return secrets or KeyringSecretStore()

        if command == "pair":
            return asyncio.run(
                pairing.pair(
                    settings,
                    open_store,
                    args.name,
                    if_needed=args.if_needed,
                    no_browser=args.no_browser,
                    installing=args.installing,
                )
            )
        if command == "status":
            return asyncio.run(pairing.status(settings, open_store))
        if command == "tv-pair":
            return asyncio.run(
                tv.tv_pair(
                    settings,
                    args.host,
                    args.name,
                    args.kind,
                    open_store(),
                    ask_code_in_window if args.installing else tv._ask_tv_code,
                    if_needed=args.if_needed,
                    identify=identify_tv,
                )
            )
        if command == "tv-find":
            return asyncio.run(tv.tv_find(args.kind))
        if command == "tv-volume":
            return asyncio.run(tv.tv_volume(settings))
        if command == "self-update":
            return maintenance.update_agent(
                sync=not args.no_sync, settings=settings, kit=kit, apply=args.apply
            )
        if command == "diagnose":
            return asyncio.run(maintenance.diagnose(settings, repair=args.repair))
        if command == "pc-control":
            return pc.pc_control(settings, args.state)
        if command == "tray":
            # pystray e Pillow sao opcionais para o processo principal: sem bandeja, a TV segue
            # funcionando e o supervisor tentara o icone de novo depois.
            from uniover_agent.adapters.tray import run_tray  # noqa: PLC0415 - dependência opcional

            return run_tray()
        if os.environ.pop("UNIOVER_LEGACY_TAKEOVER", None):
            # O lançador novo já foi destacado; o wrapper legado fica sem o código antigo e não
            # deve abrir uma segunda conexão com a API.
            return system.EXIT_OK
        # Uma vez por processo (o laço abaixo recomeça quando a TV muda de endereço).
        _keep_responsive()
        while True:
            code = asyncio.run(connection.run(settings, open_store, kit, handover=handover))
            # Um recomeço (a TV mudou de endereço) já é desta execução, dona da instalação.
            handover = False
            if code == system.EXIT_NOT_PAIRED:
                record_startup_failure("nao_pareado", "sem agent_id ou sem token no cofre")
            elif code == system.EXIT_CREDENTIAL_REJECTED and not session_started():
                # Depois de um `hello` (token revogado horas depois) não é falha de partida.
                record_startup_failure("credencial_recusada", "o servidor recusou a credencial")
            if code != system.EXIT_TV_MOVED:
                return code
            # O endereço novo da TV já está no arquivo: recomeça lendo a configuração de novo.
            settings = _load_settings()
    except (ConfigError, SecretStoreError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        if command == "run" and not session_started():
            reason = "configuracao" if isinstance(exc, ConfigError) else "cofre"
            record_startup_failure(reason, str(exc), keep=getattr(exc, "fields", ()))
        return system.EXIT_FAILURE
    except KeyboardInterrupt:
        print("Encerrado.")
        return system.EXIT_OK
    except Exception as exc:
        # O erro continua subindo (o Python o imprime e sai com 1); antes de subir, fica no disco:
        # o processo não tem janela e o que ele imprime se perde.
        if command == "run" and not session_started():
            record_startup_failure("excecao", describe_exception(exc))
        raise
