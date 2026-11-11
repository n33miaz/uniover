"""Validade dos comandos do PC: um clique ou texto entregue tarde cai em outra janela.

A API não segura comando `pc.*` enquanto o agente reconecta: sem conexão ela falha na hora. Esta
checagem é defesa em profundidade para o que mesmo assim chegar tarde (rede lenta, fila do agente):
um movimento atrasado é um salto, e um clique, tecla ou texto atrasado é uma ação na janela
errada. A idade vem do `ts` do envelope medido contra o relógio monotônico deste agente,
descontada a referência dos batimentos da API (`ClockOffset`); um PC com o relógio adiantado não
faz tudo parecer velho, e sem referência ainda (logo depois de conectar) o comando vale como
chegou. Soltar um botão (UP) e cancelar um desligamento nunca expiram: são sempre seguros.
"""

import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.clock_offset import ClockOffset

# Cliques, teclas, texto, mídia e abrir programa: ações com efeito imediato na janela em foco.
MAX_COMMAND_AGE_SECONDS: Final = 5.0
# O movimento do mouse atrasado NÃO é descartado cedo: como é relativo, o deslocamento descartado
# não volta (o dedo andou e o cursor ficou para trás). Ele é somado ao que vem junto e aplicado
# (ver `PcLane`); só o que passou de 5 s é descartado, calado (decisão do dono de 10/11).
MAX_POINTER_AGE_SECONDS: Final = 5.0
# Energia passa por confirmação na tela, então tolera mais espera, mas não a ponto de executar um
# desligamento pedido muito antes.
MAX_POWER_AGE_SECONDS: Final = 15.0
EXPIRED: Final = "expired"

_log = logging.getLogger(__name__)


def fresh_only(
    handle: Handler,
    *,
    max_age_seconds: float,
    clock: ClockOffset,
    exempt: Callable[[Command], bool] | None = None,
    quiet: bool = False,
) -> Handler:
    """Recusa (`expired`) o comando velho demais, sem chamar `handle`.

    Sem `ts` utilizável o comando vale como chegou. `exempt` libera comandos que nunca expiram.
    `quiet` é o movimento do mouse (alta taxa): cada recusa não é registrada, mas uma sequência
    longa delas é avisada uma vez (`ClockOffset.pointer_result`), porque ponteiro morto em silêncio
    é um defeito que ninguém enxerga. O registro nunca leva o corpo do comando.
    """

    async def run(command: Command) -> CommandResult:
        if exempt is not None and exempt(command):
            return await handle(command)
        age = clock.age(command.sent_at)
        if age is None or age <= max_age_seconds:
            if quiet:
                clock.pointer_result(dropped=False)
            return await handle(command)
        if quiet:
            clock.pointer_result(dropped=True, age=age)
        else:
            _log.info("comando %s recusado por idade (%.1f s)", command.type, age)
            clock.refused(age)
        return CommandResult(command.id, ResultStatus.REJECTED, "comando expirado", EXPIRED)

    return run
