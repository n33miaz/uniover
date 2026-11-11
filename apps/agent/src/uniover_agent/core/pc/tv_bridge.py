"""A ponte entre o laço do canal direto e o laço principal, para as teclas e o texto da TV.

O canal direto vive no laço da entrada do PC (uma thread só dele); a sessão da TV vive no laço
principal. Uma tecla da TV que chega pelo canal atravessa daqui para lá SEM prender o laço da
entrada: o comando vai por `to_main` (`call_soon_threadsafe`, sem espera) e o resultado volta por
`to_lane` (`post`, também sem espera). Nada aqui espera o laço principal: se ele estiver parado, o
que passou do teto de `max_pending` é recusado na hora (o app segue pela nuvem) e o que já entrou
é descartado por idade quando o laço volta, pelo mesmo caminho das teclas da nuvem.

O contador de pendentes só é tocado no laço do canal (entra em `submit`, sai em `_done`, que roda
lá), então não precisa de trava.
"""

import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus

_log = logging.getLogger(__name__)

# Comandos da TV que podem esperar o laço principal ao mesmo tempo. Um dedo gera poucas teclas por
# segundo; passar disto é o laço principal parado, e acumular mais só atrasaria o que já vai ser
# descartado por idade.
MAX_PENDING_TV: Final = 32
BUSY: Final = "busy"

# `deliver(command, received_at, on_result, valid)`: o ponto de entrada do laço principal
# (`ProcessMessage.submit_direct_tv`). `on_result` é chamado nele; a ponte o leva de volta. `valid`
# diz se a sessão do canal que mandou o comando ainda vale: conferido no laço principal.
Deliver = Callable[[Command, float, Callable[[CommandResult], None], Callable[[], bool]], None]
CHANNEL_CLOSED: Final = "channel_closed"


class TvDirectBridge:
    """Leva comandos da TV do laço do canal ao laço principal e a resposta de volta."""

    def __init__(
        self,
        deliver: Deliver,
        *,
        to_main: Callable[..., None],
        to_lane: Callable[[Callable[[], None]], None],
        max_pending: int = MAX_PENDING_TV,
    ) -> None:
        self._deliver = deliver
        self._to_main = to_main
        self._to_lane = to_lane
        self._max_pending = max_pending
        self._pending = 0
        self._refused = 0

    @property
    def pending(self) -> int:
        return self._pending

    def submit(
        self,
        command: Command,
        received_at: float,
        on_result: Callable[[CommandResult], None],
        valid: Callable[[], bool] = lambda: True,
    ) -> None:
        """Chamado no laço do canal. Nunca bloqueia."""
        if self._pending >= self._max_pending:
            self._refused += 1
            if self._refused == 1 or self._refused % 50 == 0:
                _log.warning("teclas da TV pelo canal recusadas: o laço principal não responde")
            on_result(CommandResult(command.id, ResultStatus.REJECTED, "ocupado", BUSY))
            return
        self._pending += 1

        def finish(result: CommandResult) -> None:
            # Roda no laço principal: o resultado volta ao laço do canal, onde o `ack` sai.
            self._to_lane(lambda: self._done(on_result, result))

        self._to_main(self._guarded, command, received_at, finish, valid)

    def _guarded(
        self,
        command: Command,
        received_at: float,
        finish: Callable[[CommandResult], None],
        valid: Callable[[], bool],
    ) -> None:
        """Roda no laço principal: um erro na entrega não pode deixar a vaga ocupada para sempre.

        O canal que mandou a tecla pode ter fechado (revogação, troca, queda) enquanto ela esperava:
        ela é
        recusada e a vaga é liberada, nunca entregue à TV."""
        if not valid():
            finish(
                CommandResult(command.id, ResultStatus.REJECTED, "canal fechado", CHANNEL_CLOSED)
            )
            return
        try:
            self._deliver(command, received_at, finish, valid)
        except Exception:
            _log.exception("falha ao entregar a tecla da TV do canal direto")
            finish(CommandResult(command.id, ResultStatus.FAILED, "falha interna", "failed"))

    def _done(self, on_result: Callable[[CommandResult], None], result: CommandResult) -> None:
        self._pending = max(0, self._pending - 1)
        on_result(result)
