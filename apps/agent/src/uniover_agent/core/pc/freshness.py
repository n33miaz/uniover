"""Validade dos comandos do PC: um clique ou texto entregue tarde cai em outra janela.

A API segura um comando enquanto o agente reconecta (até 25 s) e o entrega de uma vez. Para o
movimento do mouse isso é um salto; para um clique, tecla ou texto, é uma ação na janela errada. A
idade vem do `ts` do envelope, descontada a diferença entre o relógio deste PC e o da API
(`ClockOffset`): um PC com o relógio adiantado não faz tudo parecer velho. Soltar um botão (UP) e
cancelar um desligamento nunca expiram: são sempre seguros.
"""

import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.clock_offset import ClockOffset

# Cliques, teclas, texto, mídia e abrir programa: ações com efeito imediato na janela em foco.
MAX_COMMAND_AGE_SECONDS: Final = 5.0
# O movimento do mouse é descartado calado e cedo: o app já manda o próximo.
MAX_POINTER_AGE_SECONDS: Final = 2.0
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

    Sem idade conhecida (sem `ts` utilizável ou sem amostras ainda) vale como chegou. `exempt`
    libera comandos que nunca expiram. `quiet` não registra a recusa (o movimento do mouse, de alta
    taxa). O registro nunca leva o corpo do comando.
    """

    async def run(command: Command) -> CommandResult:
        if exempt is not None and exempt(command):
            return await handle(command)
        age = clock.age(command.sent_at)
        if age is None or age <= max_age_seconds:
            return await handle(command)
        if not quiet:
            _log.info("comando %s recusado por idade (%.1f s)", command.type, age)
            clock.refused(age)
        return CommandResult(command.id, ResultStatus.REJECTED, "comando expirado", EXPIRED)

    return run
