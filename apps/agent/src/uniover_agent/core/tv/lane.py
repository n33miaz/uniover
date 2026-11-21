"""A faixa das teclas da TV: a fila ordenada de teclas, texto e entrada (nuvem e canal direto).

Teclas, texto, POWER e os outros comandos de entrada da TV entram numa cadeia só, em tarefas
encadeadas na ordem de chegada: a MESMA para a nuvem e para o canal direto, de modo que a ordem, o
descarte por idade e a junção de repetições valem para as duas. Só a resposta muda (`reply`; sem
ela, o `sender`).

A faixa pode viver no laço principal (os testes e o uso simples) ou num laço só dela, junto da
sessão com a TV (uma thread, como a entrada do PC): aí o laço principal só valida a mensagem e a
entrega com `post`, e uma parada dele não atrasa as teclas que já entraram nem as do canal direto,
que nem passam por ele. Tudo aqui roda no laço da faixa; nada é tocado de outra thread.
"""

import asyncio
import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.core.command_runner import CommandRunner, Reply
from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.tv.handlers import TimedKeyCommand, ValidatedCommand
from uniover_agent.ports import TransportError

_log = logging.getLogger(__name__)

# Os caminhos por onde uma tecla da TV chega; a mudança de um para o outro vai ao registro (uma
# linha por mudança, nunca por tecla).
PATH_CLOUD: Final = "nuvem"
PATH_DIRECT: Final = "canal direto"
# O código com que o caminho direto recusa o que a nuvem trataria de outro jeito.
NOT_ALLOWED: Final = "not_allowed"
CHANNEL_CLOSED: Final = "channel_closed"
_TEXT_TYPE: Final = "tv.text.v1"
_TV_KEY_PREFIX: Final = "tv.key."


class TvLane:
    """A cadeia das teclas da TV e quem ainda não respondeu (ver `aclose`)."""

    def __init__(
        self,
        runner: CommandRunner,
        handle_command: HandleCommand,
        *,
        monotonic: Callable[[], float],
        clock_ns: Callable[[], int],
        on_command: Callable[[Command], None] | None = None,
    ) -> None:
        self._runner = runner
        self._handle_command = handle_command
        self._monotonic = monotonic
        self._clock_ns = clock_ns
        self._on_command = on_command
        self._tasks: set[asyncio.Task[None]] = set()
        self._key_tasks: set[asyncio.Task[None]] = set()
        self._last_key_task: asyncio.Task[None] | None = None
        # Os comandos aceitos que ainda não terminaram (e quem os responde): ao fechar, os que foram
        # cancelados sem resposta recebem `agent_stopping`.
        self._unanswered: dict[asyncio.Task[None], tuple[Command, Reply | None]] = {}
        self._latest_key: dict[str, int] = {}
        # Por qual caminho a última tecla da TV chegou, e quantas vieram por ele desde a mudança.
        self._path: str | None = None
        self._path_count = 0

    @property
    def path(self) -> str | None:
        return self._path

    @property
    def tasks(self) -> frozenset[asyncio.Task[None]]:
        return frozenset(self._tasks)

    # ---- entradas (todas no laço da faixa) ----

    def accept_key(  # noqa: PLR0913 - a tecla e o que se mediu na chegada
        self,
        command: Command,
        received_at: float,
        sent_age: float | None,
        *,
        reply: Reply | None = None,
        path: str = PATH_CLOUD,
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """Põe uma tecla na fila. `received_at` e `sent_age` foram medidos na CHEGADA (no laço
        que a recebeu): batimentos atrasados que vêm logo atrás desta tecla (o agente voltando de
        uma parada) não a fazem parecer nova."""
        self._note_path(path)
        key = command.body["key"]
        direction = command.body.get("direction") or "SHORT"
        is_latest = self._newest_press(key) if direction == "SHORT" else None
        timed = TimedKeyCommand(
            command.id,
            command.type,
            command.body,
            command.correlation_id,
            command.sent_at,
            received_at=received_at,
            is_latest=is_latest,
            is_valid=is_valid,
            sent_age=sent_age,
            path=path,
            # Só para medir os trechos da tecla (fila, sessão, envio) no registro do agente. A
            # tecla chegou antes (`received_at`): a espera até aqui conta como fila.
            received_ns=self._clock_ns()
            - max(0, round((self._monotonic() - received_at) * 1_000_000_000)),
        )
        task = asyncio.create_task(self._execute_key(timed, self._last_key_task, reply))
        self._chain(task, command, reply)

    def accept_text(
        self,
        command: Command,
        reply: Reply | None = None,
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """O texto espera as teclas anteriores e não tem o teto delas (o editor confere o seu)."""
        task = asyncio.create_task(
            self._execute_text(command, self._last_key_task, reply, is_valid)
        )
        self._chain(task, command, reply)

    def accept_ordered(self, command: Command) -> None:
        """POWER, abrir app, ligar e desligar: na cadeia das teclas, com o teto dos comandos.

        Aqui nada é juntado nem descartado por idade; a sessão é quem ignora um POWER que repete o
        anterior em poucos segundos (o toque duplo religaria a TV)."""
        task = asyncio.create_task(self._execute_after(command, self._last_key_task))
        self._chain(task, command, None)

    def submit_direct(
        self,
        command: Command,
        received_at: float,
        on_result: Callable[[CommandResult], None],
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """Uma tecla ou um texto da TV que chegou pelo canal direto (já validado pelo esquema).

        `is_valid` diz se a sessão do canal ainda vale: conferida aqui, antes da fila, e de
        novo antes de a tecla ir à TV (a revogação não deixa passar uma tecla já enfileirada).

        Entra no MESMO caminho da nuvem: o mesmo `on_command` (o agendador de limpeza), a mesma
        fila de teclas, o mesmo descarte por idade e a mesma junção. `received_at` é o instante em
        que o canal recebeu o comando (relógio monotônico do processo). Só tecla (menos `POWER`) e
        texto; qualquer outra coisa é recusada sem tocar na TV. O resultado volta por `on_result`,
        que quem ligou a ponte leva de volta ao laço do canal."""
        if self._on_command is not None:
            self._on_command(command)
        is_key = command.type.startswith(_TV_KEY_PREFIX)
        is_text = command.type == _TEXT_TYPE
        refused = CommandResult(command.id, ResultStatus.REJECTED, "não permitido", NOT_ALLOWED)
        if not (is_key or is_text) or (is_key and command.body.get("key") == "POWER"):
            on_result(refused)
            return
        if is_valid is not None and not is_valid():
            on_result(
                CommandResult(command.id, ResultStatus.REJECTED, "canal fechado", CHANNEL_CLOSED)
            )
            return

        async def reply(done: Command, result: CommandResult) -> None:
            on_result(result)

        if is_key and self._handle_command.handles_fresh_keys(command.type):
            self.accept_key(
                command, received_at, None, reply=reply, path=PATH_DIRECT, is_valid=is_valid
            )
        elif is_text:
            self._note_path(PATH_DIRECT)
            self.accept_text(command, reply, is_valid)
        else:
            on_result(refused)

    # ---- execução ----

    def _chain(self, task: asyncio.Task[None], command: Command, reply: Reply | None) -> None:
        """Entra na cadeia das teclas (a ordem de chegada vale para quem vem depois)."""
        self._last_key_task = task
        self._key_tasks.add(task)
        task.add_done_callback(self._key_tasks.discard)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        self._unanswered[task] = (command, reply)
        task.add_done_callback(self._settled)

    def _settled(self, task: asyncio.Task[None]) -> None:
        # Terminou por conta própria: a resposta já saiu (ou o envio falhou e foi registrado).
        # Cancelada, fica para o `aclose` responder.
        if not task.cancelled():
            self._unanswered.pop(task, None)

    def _note_path(self, path: str) -> None:
        """Conta as teclas por caminho e deixa uma linha no registro quando o caminho muda."""
        if path == self._path:
            self._path_count += 1
            return
        if self._path is not None:
            _log.info(
                "teclas da TV: %d pelo caminho %s; agora pelo caminho %s",
                self._path_count,
                self._path,
                path,
            )
        else:
            _log.info("teclas da TV: primeira pelo caminho %s", path)
        self._path = path
        self._path_count = 1

    def _newest_press(self, key: str) -> Callable[[], bool]:
        self._latest_key[key] = self._latest_key.get(key, 0) + 1
        sequence = self._latest_key[key]

        def is_latest() -> bool:
            return self._latest_key[key] == sequence

        return is_latest

    async def _execute_after(self, command: Command, previous: asyncio.Task[None] | None) -> None:
        """Espera a vez na cadeia e executa com o teto; um anterior que falhou não a trava."""
        if previous is not None:
            await asyncio.wait([previous])
        await self._runner.execute_detached(command)

    async def _execute_key(
        self,
        command: TimedKeyCommand,
        previous: asyncio.Task[None] | None,
        reply: Reply | None = None,
    ) -> None:
        # O envio de RIGHT seguido de OK não pode ser invertido por duas tarefas que aquecem
        # ou reabrem o mesmo canal ao mesmo tempo. A recepção segue livre enquanto elas esperam.
        if previous is not None:
            await previous
        await self._runner.execute_detached(command, reply)

    async def _execute_text(
        self,
        command: Command,
        previous: asyncio.Task[None] | None,
        reply: Reply | None,
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        if previous is not None:
            await asyncio.wait([previous])
        if is_valid is not None and not is_valid() and reply is not None:
            await reply(
                command,
                CommandResult(command.id, ResultStatus.REJECTED, "canal fechado", CHANNEL_CLOSED),
            )
            return
        try:
            # O texto leva a validade ao handler: conferida ao obter a vez e antes de cada efeito.
            checked = (
                command
                if is_valid is None
                else ValidatedCommand(
                    command.id,
                    command.type,
                    command.body,
                    command.correlation_id,
                    command.sent_at,
                    is_valid=is_valid,
                )
            )
            await self._runner.execute(checked, reply)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    # ---- encerramento ----

    async def drain(self, grace: float) -> None:
        """Dá até `grace` segundos para o que está na fila terminar sozinho, sem cancelar."""
        pending = [task for task in self._tasks if not task.done()]
        if pending:
            await asyncio.wait(pending, timeout=grace)

    async def aclose(self) -> None:
        """Cancela o que ainda está na fila (e espera); quem ficou sem resposta recebe
        `agent_stopping`."""
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        unanswered = list(self._unanswered.values())
        self._unanswered.clear()
        await self._runner.answer_stopping(unanswered)
