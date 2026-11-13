"""O programa que precisa estar na frente (`target` de `pc.key.*` e `pc.text.*`).

Os controles por programa do app (YouTube, Netflix, Spotify, VLC, navegador) mandam teclas que só
fazem sentido naquele programa: Ctrl+W fecha a aba no navegador, mas noutro programa pode fechar
um documento. Com `target`, o agente confere o executável da janela da frente antes de apertar
qualquer coisa e, se não for o programa, recusa sem enviar nada. Sem `target` (o teclado livre, o
mouse, Música, Vídeo e Slides) tudo segue como sempre.
"""

import logging
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports.pc import PcForeground

_log = logging.getLogger(__name__)

# No `hello`, só depois de a API listá-la em `features`: o agente confere o `target`.
PC_TARGET_CAPABILITY: Final = "pc.target.v1"
# O código da recusa: o app o traduz em "Abra o <programa> no PC e deixe-o na frente."
APP_NOT_IN_FRONT: Final = "app_not_in_front"

# Os executáveis de cada programa do contrato.
PROGRAMS: Final[dict[str, frozenset[str]]] = {
    "browser": frozenset({"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe"}),
    "spotify": frozenset({"spotify.exe"}),
    "vlc": frozenset({"vlc.exe"}),
}
_NAMES: Final[dict[str, str]] = {"browser": "o navegador", "spotify": "o Spotify", "vlc": "o VLC"}


def in_front(target: str, program: str | None) -> bool:
    """O executável da frente é do programa pedido? Programa desconhecido nunca está na frente."""
    return program is not None and program.lower() in PROGRAMS.get(target, frozenset())


def focus_guarded(handle: Handler, foreground: PcForeground) -> Handler:
    """Só aperta quando o programa do `target` está na frente; sem `target`, chama `handle` como
    antes. A soltura de um modificador (`action` `UP`) nunca é barrada: é o que o impede de ficar
    preso. O nome do executável nunca vai para o registro."""

    async def run(command: Command) -> CommandResult:
        target = command.body.get("target")
        if target is None or command.body.get("action") == "UP":
            return await handle(command)
        try:
            program = foreground.program()
        except OSError:
            program = None
        if not in_front(str(target), program):
            _log.info("%s recusado: %s não está na frente", command.type, target)
            name = _NAMES.get(str(target), "o programa")
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                f"Abra {name} no PC e deixe-o na frente.",
                APP_NOT_IN_FRONT,
            )
        return await handle(command)

    return run
