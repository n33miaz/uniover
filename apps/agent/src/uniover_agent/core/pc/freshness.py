"""Validade dos comandos do PC: um clique ou texto entregue tarde cai em outra janela.

A API segura um comando enquanto o agente reconecta (até 25 s) e o entrega de uma vez. Para o
movimento do mouse isso é um salto; para um clique, tecla ou texto, é uma ação na janela errada. O
`ts` do envelope é a hora em que a API montou a mensagem, então a idade é medida por ele, como o
sinal de presença da TV faz. Soltar um botão (UP) nunca expira: soltar é sempre seguro.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler

# Cliques, teclas, texto, mídia e abrir programa: ações com efeito imediato na janela em foco.
MAX_COMMAND_AGE_SECONDS: Final = 5.0
# O movimento do mouse é descartado calado e cedo: o app já manda o próximo.
MAX_POINTER_AGE_SECONDS: Final = 2.0
# Energia passa por confirmação na tela, então tolera mais espera, mas não a ponto de executar um
# desligamento pedido muito antes.
MAX_POWER_AGE_SECONDS: Final = 15.0
# Folga para o relógio deste PC estar um pouco atrás do da API (idade negativa).
MAX_CLOCK_SKEW_SECONDS: Final = 5.0
EXPIRED: Final = "expired"

_log = logging.getLogger(__name__)


def _age_seconds(sent_at: str | None, now: datetime) -> float | None:
    if not sent_at:
        return None
    try:
        sent = datetime.fromisoformat(sent_at)
    except ValueError:
        return None
    if sent.tzinfo is None:
        return None
    return (now - sent).total_seconds()


def fresh_only(
    handle: Handler,
    *,
    max_age_seconds: float,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    exempt: Callable[[Command], bool] | None = None,
    quiet: bool = False,
) -> Handler:
    """Recusa (`expired`) o comando velho demais, sem chamar `handle`.

    Sem `ts` utilizável vale como chegou. Idade negativa vale até `MAX_CLOCK_SKEW_SECONDS`: além
    disso o relógio deste PC está muito atrasado e nada se saberia da idade, então recusa e avisa
    uma vez no log. `exempt` libera comandos que nunca expiram. `quiet` não registra a recusa
    (o movimento do mouse, de alta taxa). O registro nunca leva o corpo do comando.
    """
    warned_skew = False

    async def run(command: Command) -> CommandResult:
        nonlocal warned_skew
        if exempt is not None and exempt(command):
            return await handle(command)
        age = _age_seconds(command.sent_at, now())
        if age is None or -MAX_CLOCK_SKEW_SECONDS <= age <= max_age_seconds:
            return await handle(command)
        if age < -MAX_CLOCK_SKEW_SECONDS:
            if not warned_skew:
                warned_skew = True
                _log.warning(
                    "comando do PC recusado: o `ts` dele está %.0f s à frente do relógio deste PC "
                    "(relógio do PC fora de hora?)",
                    -age,
                )
            return CommandResult(
                command.id, ResultStatus.REJECTED, "relógio do PC fora de hora", EXPIRED
            )
        if not quiet:
            _log.info("comando %s recusado por idade (%.1f s)", command.type, age)
        return CommandResult(command.id, ResultStatus.REJECTED, "comando expirado", EXPIRED)

    return run
