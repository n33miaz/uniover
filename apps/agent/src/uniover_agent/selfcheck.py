"""Auto-diagnóstico local, sem rede e sem efeito colateral: `python -m uniover_agent.selfcheck`.

Quem o roda é a atualização, **dentro da versão candidata**, antes de trocar a pasta: se o código
novo não carrega, não compila os contratos ou não aceita o `agent.toml` que este PC tem hoje, a
troca não acontece e o agente que funciona continua no lugar. Também serve a quem quiser conferir
uma instalação à mão.

Não abre conexão, não lê o Cofre de Credenciais, não escreve nada e não chama `migrate_layout`: uma
candidata sendo ensaiada nunca pode mexer na instalação real.
"""

import importlib
import sys
from collections.abc import Callable

EXIT_OK = 0
EXIT_PROBLEM = 1


def _load_code() -> None:
    main = importlib.import_module("uniover_agent.main")
    # O `main` importa cada parte só no comando que a usa: aqui todas, como antes.
    for name in main.LAZY_MODULES:
        importlib.import_module(name)


def _load_tray() -> None:
    """A bandeja é um processo à parte e o supervisor a trata como opcional, então uma quebra só
    nela não volta atrás sozinha: carrega aqui o módulo (pystray, Pillow, menu, host), sem abrir o
    host nem criar o ícone."""
    if sys.platform != "win32":
        return  # o host visual da bandeja é do Windows
    importlib.import_module("uniover_agent.adapters.tray")


def _load_contracts() -> None:
    from uniover_agent.core.envelope_gate import EnvelopeGate  # noqa: PLC0415 - só aqui

    EnvelopeGate("selfcheck")


def _load_configuration() -> None:
    from uniover_agent.config import (  # noqa: PLC0415 - só aqui
        Settings,
        require_api_url,
        require_cleanup_keep,
        require_tv_host,
    )

    settings = Settings()
    require_cleanup_keep(settings)
    if settings.api_url:
        require_api_url(settings)
    if settings.tv_host:
        require_tv_host(settings.tv_host)


STEPS: tuple[tuple[str, Callable[[], None]], ...] = (
    ("o código novo carrega", _load_code),
    ("a bandeja carrega", _load_tray),
    ("os contratos das mensagens compilam", _load_contracts),
    ("a configuração deste PC é aceita", _load_configuration),
)


def run() -> list[str]:
    """Os problemas achados, um por frase (lista vazia: tudo certo)."""
    problems: list[str] = []
    for what, step in STEPS:
        try:
            step()
        except Exception as exc:
            # Só o tipo e a frase do nosso código: a mensagem de uma biblioteca pode trazer
            # caminhos.
            reason = str(exc) if exc.__class__.__module__.startswith("uniover_agent") else ""
            problems.append(
                f"falhou em '{what}' ({type(exc).__name__}{': ' + reason if reason else ''})"
            )
    return problems


def main() -> int:
    problems = run()
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return EXIT_PROBLEM
    print("auto-diagnóstico da versão: tudo certo")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
