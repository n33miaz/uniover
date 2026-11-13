"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from functools import partial
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand
from uniover_agent.core.pc.lane import (
    LATE_POINTER_WARNING,
    MAX_PENDING_PC,
    MAX_PENDING_RESULTS,
    PcLane,
)
from uniover_agent.core.tv.handlers import TimedKeyCommand, ValidatedCommand
from uniover_agent.core.tv.session import TV_UNREACHABLE
from uniover_agent.ports import LaneHost, Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"
# Comandos do PC têm faixa própria: não esperam as teclas da TV nem as seguram.
_PC_PREFIX = "pc."
# O canal direto (`pc.rtc.*`) é sinalização, não comando de entrada: a oferta espera a biblioteca
# carregar e não pode ficar atrás do mouse da nuvem (nem segurá-lo).
_RTC_PREFIX = "pc.rtc."
# Quanto esperar a faixa do PC (em outro laço) encerrar.
_LANE_CLOSE_SECONDS: Final = 5.0
# Os caminhos por onde uma tecla da TV chega; a mudança de um para o outro vai ao registro (uma
# linha por mudança, nunca por tecla).
PATH_CLOUD: Final = "nuvem"
PATH_DIRECT: Final = "canal direto"
# O código com que o caminho direto recusa o que a nuvem trataria de outro jeito.
NOT_ALLOWED: Final = "not_allowed"
# Entrada da pessoa na TV: entra na cadeia das teclas (a mesma ordem de chegada), sem prender o
# leitor. As teclas (inclusive POWER) também entram nela.
ORDERED_TYPES: Final = frozenset(
    {
        "tv.text.v1",
        "tv.wake.v1",
        "tv.power.off.v1",
        "tv.app.launch.v1",
        "tv.settings.open.v1",
    }
)
# Manutenção pedida pelo app: faixa própria, um por vez, com o teto dos comandos; nem o leitor
# nem as teclas esperam por ela.
MAINTENANCE_TYPES: Final = frozenset(
    {
        "tv.apps.refresh.v1",
        "tv.adb.rebind.v1",
        "tv.cleanup.config.v1",
        "agent.logs.request.v1",
        "agent.maintenance.v1",
    }
)
# Resposta de quem foi aceito e não terminou quando o agente fecha (encerramento ou passagem para a
# versão nova, depois do prazo do `drain`): todo comando aceito recebe uma resposta só.
AGENT_STOPPING: Final = "agent_stopping"
_STOPPING_MESSAGE: Final = (
    "o agente está encerrando ou trocando de versão; o comando pode não ter terminado, "
    "tente de novo em instantes"
)
_TV_KEY_PREFIX = "tv.key."
_TEXT_TYPE = "tv.text.v1"
# Os ids que já chegaram, só em memória (~60 KB no máximo): o mesmo id não executa duas vezes.
RECENT_COMMAND_SECONDS: Final = 120.0
RECENT_COMMAND_CAPACITY: Final = 512
# `POWER` alterna a TV (o mesmo id repetido a ligaria de novo): a lembrança dele é à parte, mais
# longa e que nenhuma outra tecla expulsa. Só os ids de POWER entram aqui (no ritmo de uma pessoa).
RECENT_POWER_SECONDS: Final = 24 * 60 * 60.0
RECENT_POWER_CAPACITY: Final = 256

# Como o resultado de um comando volta a quem o pediu: pela nuvem (o transporte) ou, no canal
# direto, pela resposta do próprio canal.
Reply = Callable[[Command, CommandResult], Awaitable[None]]


@dataclass(slots=True)
class _RecentCommand:
    """Quando o id chegou e, depois de terminar, a resposta que ele deu."""

    accepted_at: float
    result: CommandResult | None = None


def _is_power(command: Command) -> bool:
    """`POWER` pelo caminho das teclas da TV: interruptor, nunca pode executar duas vezes."""
    return command.type.startswith(_TV_KEY_PREFIX) and command.body.get("key") == "POWER"


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    O leitor nunca espera a TV. Teclas, texto, POWER e os outros comandos de entrada
    (`ordered_types`) entram numa cadeia só, em tarefas encadeadas na ordem de chegada. A manutenção
    (`maintenance_types`: lista de apps, rebind, diagnóstico) corre noutra cadeia, um comando por
    vez, cada um com o teto `command_timeout_seconds` contado quando chega a vez dele. Comandos em
    `background_types` rodam em tarefa própria, soltos. O resto (presença, pedaço de foto) é rápido
    e é atendido no próprio leitor. Comandos em `silent_types` são executados mas não respondidos.

    Os comandos `pc.*` correm numa faixa à parte (`PcLane`): um só consumidor os executa um após o
    outro, na ordem de chegada (apertar, mover, soltar), sem esperar as teclas da TV e sem que
    elas esperem por eles. Em produção a faixa vive num laço de eventos próprio (`pc_host`, uma
    thread dedicada): o laço principal só valida a mensagem e a entrega com `post`, na ordem de
    chegada. Sem `pc_lane` a faixa nasce aqui, no mesmo laço (os testes e o uso simples).
    `release_inputs` solta os botões do mouse que o PC ficou segurando; é chamado quando a conexão
    cai e ao encerrar, depois de parar a faixa.
    """

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        agent_id: str,
        gate: EnvelopeGate,
        handle_command: HandleCommand,
        envelopes: EnvelopeFactory,
        transport: Transport,
        *,
        background_types: Collection[str] = (),
        silent_types: Collection[str] = (),
        monotonic: Callable[[], float] = time.monotonic,
        on_command: Callable[[Command], None] | None = None,
        command_timeout_seconds: float | None = None,
        uncapped_types: Collection[str] = (),
        release_inputs: Callable[[], None] | None = None,
        observe_timestamp: Callable[[str | None], None] | None = None,
        timestamp_age: Callable[[str | None], float | None] | None = None,
        on_cloud_pc_input: Callable[[str, int | None, str | None], None] | None = None,
        on_release_queued: Callable[[], None] | None = None,
        pc_lane: PcLane | None = None,
        pc_host: LaneHost | None = None,
        lane_detached_types: Collection[str] = (),
        direct_active: Callable[[], bool] | None = None,
        ordered_types: Collection[str] = ORDERED_TYPES,
        maintenance_types: Collection[str] = MAINTENANCE_TYPES,
    ) -> None:
        self._agent_id = agent_id
        self._gate = gate
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._transport = transport
        self._background_types = frozenset(background_types)
        self._silent_types = frozenset(silent_types)
        self._monotonic = monotonic
        self._on_command = on_command
        # Teto de um comando em tarefa própria: uma tecla presa não pode segurar para sempre o
        # texto e o POWER que esperam por ela. Os tipos longos por natureza ficam de fora.
        self._command_timeout = command_timeout_seconds
        self._uncapped_types = frozenset(uncapped_types)
        # Recebe o `ts` de cada batimento da API (`api.keepalive.v1`): só ele, que a API nunca
        # segura, serve para estimar a diferença entre o relógio dela e o monotônico deste agente.
        # Um comando `pc.*` não entra aí: se tivesse chegado atrasado, ensinaria a estimativa a
        # tratar o atraso como normal.
        self._observe_timestamp = observe_timestamp
        # A idade de um comando desde o envio pela API, por essa mesma estimativa (`None`: ainda
        # sem referência). As teclas da TV que chegam pela nuvem a usam para expirar.
        self._timestamp_age = timestamp_age
        self._tasks: set[asyncio.Task[None]] = set()
        # A faixa do PC: ou a de fora (laço próprio) ou uma nesta mesma thread.
        self._lane = pc_lane or PcLane(
            handle_command,
            envelopes,
            transport,
            silent_types=silent_types,
            monotonic=monotonic,
            release_inputs=release_inputs,
            on_cloud_pc_input=on_cloud_pc_input,
            on_release_queued=on_release_queued,
            direct_active=direct_active,
        )
        self._pc_host: LaneHost | None = pc_host if pc_lane is not None else None
        # Os comandos `pc.*` que a faixa executa fora da fila (a sinalização do canal direto).
        self._lane_detached_types = frozenset(lane_detached_types)
        self._key_tasks: set[asyncio.Task[None]] = set()
        self._last_key_task: asyncio.Task[None] | None = None
        self._ordered_types = frozenset(ordered_types)
        self._maintenance_types = frozenset(maintenance_types)
        # A faixa da manutenção: a última tarefa dela (a próxima espera esta terminar).
        self._last_maintenance_task: asyncio.Task[None] | None = None
        # Os comandos aceitos em tarefa que ainda não terminaram (e quem os responde): ao fechar,
        # os que foram cancelados sem resposta recebem `agent_stopping`.
        self._unanswered: dict[asyncio.Task[None], tuple[Command, Reply | None]] = {}
        self._latest_key: dict[str, int] = {}
        # Por qual caminho a última tecla da TV chegou, e quantas vieram por ele desde a mudança.
        self._tv_path: str | None = None
        self._tv_path_count = 0
        self._recent: OrderedDict[str, _RecentCommand] = OrderedDict()
        self._recent_power: OrderedDict[str, _RecentCommand] = OrderedDict()

    async def __call__(self, raw: str | bytes) -> None:
        outcome = self._gate.check_inbound(raw)
        if isinstance(outcome, Rejected):
            await self._reject(outcome)
            return

        command = outcome.command
        if command.type == _KEEPALIVE_TYPE:
            if self._observe_timestamp is not None:
                self._observe_timestamp(command.sent_at)
            # Batimento da API: já chegou pelo canal; não executa comando nem produz resultado.
            return
        if await self._is_repeat(command):
            return
        # Só o comando novo conta como uso (agendador da limpeza); o repetido não aconteceu de novo.
        if self._on_command is not None:
            self._on_command(command)
        if (
            command.type.startswith("tv.key.")
            and command.body.get("key") != "POWER"
            and self._handle_command.handles_fresh_keys(command.type)
        ):
            # A recepção continua durante a abertura lenta da sessão. Só o relógio monotônico
            # deste agente mede a espera; o horário da API pode diferir do relógio deste PC.
            self._start_key(command, self._monotonic(), None, PATH_CLOUD)
            return
        if command.type.startswith(_PC_PREFIX) and not command.type.startswith(_RTC_PREFIX):
            self._to_lane(partial(self._lane.accept, command))
            return
        if command.type in self._lane_detached_types:
            self._to_lane(partial(self._lane.run_detached, command))
            return
        if not self._start_off_reader(command):
            # Rápidos e sem ordem com as teclas (presença, pedaço de foto do TV Livre, tipo
            # desconhecido): no próprio leitor, sem esperar nada que esteja na TV.
            await self._execute(command)

    async def _is_repeat(self, command: Command) -> bool:
        """O mesmo id já chegou nos últimos 2 minutos: não executa de novo.

        `POWER` (interruptor) tem lembrança à parte, de 24 h e sem disputar vaga com as outras
        teclas: um reenvio tardio do mesmo id nunca alterna a TV de novo.

        Se o primeiro já terminou, o repetido recebe a mesma resposta; em curso, a resposta do
        primeiro (que leva o mesmo id) serve aos dois. Ficam de fora o fluxo sem resposta (o
        movimento do mouse, dezenas por segundo, empurraria os outros ids para fora) e os `pc.*`,
        entrada que a API nunca reenvia e que a faixa do PC (outro laço) responde por conta própria.
        """
        if command.type in self._silent_types or command.type.startswith(_PC_PREFIX):
            return False
        now = self._monotonic()
        if _is_power(command):
            recent, seconds, capacity = (
                self._recent_power,
                RECENT_POWER_SECONDS,
                RECENT_POWER_CAPACITY,
            )
        else:
            recent, seconds, capacity = (
                self._recent,
                RECENT_COMMAND_SECONDS,
                RECENT_COMMAND_CAPACITY,
            )
        # A ordem é a de chegada: os mais antigos ficam na frente.
        while recent and now - next(iter(recent.values())).accepted_at > seconds:
            recent.popitem(last=False)
        previous = recent.get(command.id)
        if previous is None:
            if len(recent) >= capacity:
                recent.popitem(last=False)
            recent[command.id] = _RecentCommand(now)
            return False
        _log.info("comando %s repetido ignorado (id=%s)", command.type, command.id)
        if previous.result is not None:
            await self._reply_result(command, previous.result)
        return True

    def _remember_result(self, command: Command, result: CommandResult) -> None:
        entry = (self._recent_power if _is_power(command) else self._recent).get(command.id)
        if entry is not None:
            entry.result = result

    async def _reply_result(
        self, command: Command, result: CommandResult, reply: Reply | None = None
    ) -> None:
        """Pelo canal direto o resultado volta pelo próprio canal; pela nuvem, pelo transporte."""
        if reply is not None:
            await reply(command, result)
            return
        if command.type in self._silent_types:
            # Fluxo de alta taxa (o movimento do mouse): a API o manda sem esperar resposta, e uma
            # resposta por movimento só encheria o canal e o registro dela.
            return
        # A API manda o comando com `correlationId` nulo e espera o resultado apontando o `id` dele.
        await self._transport.send(
            self._envelopes.result(
                command.id,
                ok=result.status.value == "ok",
                code=result.code or result.status.value,
                message=result.detail,
            )
        )

    def _start_off_reader(self, command: Command) -> bool:
        """Põe o comando numa tarefa (solta, na cadeia das teclas ou na faixa da manutenção) e diz
        se pôs. O leitor nunca espera por elas."""
        if command.type in self._background_types:
            self._track(asyncio.create_task(self._execute_detached(command)), command, None)
        elif command.type == _TEXT_TYPE:
            # O texto espera as teclas anteriores e não tem o teto delas (o editor confere o seu).
            task = asyncio.create_task(self._execute_text(command, self._last_key_task, None))
            self._chain(task, command, None)
        elif command.type.startswith(_TV_KEY_PREFIX) or command.type in self._ordered_types:
            # POWER, abrir app, ligar e desligar: na cadeia das teclas, com o teto dos comandos.
            # Aqui nada é juntado nem descartado por idade; a sessão é quem ignora um POWER que
            # repete o anterior em poucos segundos (o toque duplo religaria a TV).
            task = asyncio.create_task(self._execute_after(command, self._last_key_task))
            self._chain(task, command, None)
        elif command.type in self._maintenance_types:
            # Um por vez, na ordem de chegada; o teto conta a partir da vez de cada um.
            task = asyncio.create_task(self._execute_after(command, self._last_maintenance_task))
            self._last_maintenance_task = task
            self._track(task, command, None)
        else:
            return False
        return True

    async def _execute_after(self, command: Command, previous: asyncio.Task[None] | None) -> None:
        """Espera a vez na cadeia e executa com o teto; um anterior que falhou não a trava."""
        if previous is not None:
            await asyncio.wait([previous])
        await self._execute_detached(command)

    def _start_key(
        self,
        command: Command,
        received_at: float,
        reply: Reply | None,
        path: str,
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """Põe uma tecla da TV na fila das teclas: a MESMA para a nuvem e para o canal direto, de
        modo que a ordem, o descarte por idade e a junção de repetições valem para as duas. Só a
        resposta muda (`reply`; sem ela, o transporte)."""
        self._note_tv_path(path)
        # Pela nuvem, a idade desde o envio é lida AGORA, na chegada: batimentos atrasados que
        # vêm logo atrás desta tecla (o agente voltando de uma parada) não a fazem parecer nova.
        sent_age = (
            self._timestamp_age(command.sent_at)
            if path == PATH_CLOUD and self._timestamp_age is not None
            else None
        )
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
        )
        task = asyncio.create_task(self._execute_key(timed, self._last_key_task, reply))
        self._chain(task, command, reply)

    def _chain(self, task: asyncio.Task[None], command: Command, reply: Reply | None) -> None:
        """Entra na cadeia das teclas (a ordem de chegada vale para quem vem depois)."""
        self._last_key_task = task
        self._key_tasks.add(task)
        task.add_done_callback(self._key_tasks.discard)
        self._track(task, command, reply)

    def _track(self, task: asyncio.Task[None], command: Command, reply: Reply | None) -> None:
        """Guarda a tarefa de um comando aceito até ela terminar (ver `aclose`)."""
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        if reply is None and command.type in self._silent_types:
            return  # sem resposta por natureza
        self._unanswered[task] = (command, reply)
        task.add_done_callback(self._settled)

    def _settled(self, task: asyncio.Task[None]) -> None:
        # Terminou por conta própria: a resposta já saiu (ou o envio falhou e foi registrado).
        # Cancelada, fica para o `aclose` responder.
        if not task.cancelled():
            self._unanswered.pop(task, None)

    def _note_tv_path(self, path: str) -> None:
        """Conta as teclas por caminho e deixa uma linha no registro quando o caminho muda."""
        if path == self._tv_path:
            self._tv_path_count += 1
            return
        if self._tv_path is not None:
            _log.info(
                "teclas da TV: %d pelo caminho %s; agora pelo caminho %s",
                self._tv_path_count,
                self._tv_path,
                path,
            )
        else:
            _log.info("teclas da TV: primeira pelo caminho %s", path)
        self._tv_path = path
        self._tv_path_count = 1

    def submit_direct_tv(
        self,
        command: Command,
        received_at: float,
        on_result: Callable[[CommandResult], None],
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """Uma tecla ou um texto da TV que chegou pelo canal direto (já validado pelo esquema).

        `is_valid` diz se a sessão do canal ainda vale: conferida aqui, antes da fila, e de
        novo antes de a tecla ir à TV (a revogação não deixa passar uma tecla já enfileirada).

        Roda no laço principal (a sessão da TV vive nele) e entra no MESMO caminho da nuvem: o mesmo
        `on_command` (o agendador de limpeza), a mesma fila de teclas, o mesmo descarte por idade e
        a mesma junção. `received_at` é o instante em que o canal recebeu o comando (relógio
        monotônico do processo): uma pausa do laço principal conta como espera. Só tecla (menos
        `POWER`) e texto; qualquer outra coisa é recusada sem tocar na TV. O resultado volta por
        `on_result`, que quem ligou a ponte leva de volta ao laço do canal."""
        if self._on_command is not None:
            self._on_command(command)
        is_key = command.type.startswith("tv.key.")
        is_text = command.type == "tv.text.v1"
        refused = CommandResult(command.id, ResultStatus.REJECTED, "não permitido", NOT_ALLOWED)
        if not (is_key or is_text) or (is_key and command.body.get("key") == "POWER"):
            on_result(refused)
            return
        if is_valid is not None and not is_valid():
            on_result(
                CommandResult(command.id, ResultStatus.REJECTED, "canal fechado", "channel_closed")
            )
            return

        async def reply(done: Command, result: CommandResult) -> None:
            on_result(result)

        if is_key and self._handle_command.handles_fresh_keys(command.type):
            self._start_key(command, received_at, reply, PATH_DIRECT, is_valid)
        elif is_text:
            self._note_tv_path(PATH_DIRECT)
            # O texto espera as teclas que vieram antes (a mesma regra da nuvem) e, como lá, não tem
            # o teto das teclas: o editor de texto confere o próprio.
            self._chain(
                asyncio.create_task(
                    self._execute_text(command, self._last_key_task, reply, is_valid)
                ),
                command,
                reply,
            )
        else:
            on_result(refused)

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
                CommandResult(command.id, ResultStatus.REJECTED, "canal fechado", "channel_closed"),
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
            await self._execute(checked, reply)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    def _to_lane(self, callback: Callable[[], None]) -> None:
        """Entrega à faixa do PC: no laço dela (thread própria) ou, sem ele, agora mesmo."""
        if self._pc_host is None:
            callback()
        else:
            self._pc_host.post(callback)

    # A faixa do PC, vista de quem a usa no mesmo laço (os testes e o uso simples). Em produção a
    # montagem liga o canal direto e o pacer à própria faixa.

    @property
    def lane(self) -> PcLane:
        return self._lane

    def submit_direct(
        self, command: Command, on_result: Callable[[CommandResult], None] | None
    ) -> None:
        self._lane.submit_direct(command, on_result)

    def release_waiting(self) -> bool:
        return self._lane.release_waiting()

    def direct_lost(self) -> None:
        self._lane.direct_lost()

    def _newest_press(self, key: str) -> Callable[[], bool]:
        self._latest_key[key] = self._latest_key.get(key, 0) + 1
        sequence = self._latest_key[key]

        def is_latest() -> bool:
            return self._latest_key[key] == sequence

        return is_latest

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
        await self._execute_detached(command, reply)

    async def drain(self, grace: float) -> None:
        """Dá até `grace` segundos para o que está em curso terminar sozinho, sem cancelar.

        Na passagem para uma versão nova: uma tecla já enviada à TV termina em vez de ser cortada
        no meio. O que passar do prazo fica para o `aclose`."""

        async def own() -> None:
            pending = [task for task in self._tasks if not task.done()]
            if pending:
                await asyncio.wait(pending, timeout=grace)

        async def lane() -> None:
            # A faixa do PC roda no laço dela (a thread da entrada): é lá que o que está em curso
            # termina.
            if self._pc_host is None:
                await self._lane.drain(grace)
                return
            try:
                await self._pc_host.call(partial(self._lane.drain, grace), wait_seconds=grace + 1.0)
            except TimeoutError, RuntimeError:
                _log.warning("a faixa do PC não terminou o que tinha em curso a tempo")

        await asyncio.gather(own(), lane())

    async def aclose(self) -> None:
        """Ao encerrar o agente: cancela o que ainda roda em tarefa (e espera terminar).

        Todo comando aceito termina com uma resposta só: o que foi cancelado sem responder (em
        curso ou ainda na fila, depois do prazo do `drain` na passagem para a versão nova) recebe
        `agent_stopping`. A versão nova nunca recebe esses comandos (a API os mandou a esta
        conexão), então nada é executado duas vezes. Com o transporte já fechado a resposta não
        sai; aí vale o prazo de espera da própria API para o comando."""
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        try:
            await asyncio.gather(*pending, return_exceptions=True)
            await self._answer_stopping()
        finally:
            if self._pc_host is None:
                await self._lane.aclose()
            else:
                try:
                    await self._pc_host.call(self._lane.aclose, wait_seconds=_LANE_CLOSE_SECONDS)
                except TimeoutError, RuntimeError:
                    _log.warning("a faixa do PC não encerrou a tempo")

    async def _answer_stopping(self) -> None:
        unanswered = list(self._unanswered.values())
        self._unanswered.clear()
        for command, reply in unanswered:
            try:
                if reply is not None:
                    await reply(
                        command,
                        CommandResult(
                            command.id, ResultStatus.FAILED, _STOPPING_MESSAGE, AGENT_STOPPING
                        ),
                    )
                else:
                    await self._transport.send(
                        self._envelopes.result(
                            command.id, ok=False, code=AGENT_STOPPING, message=_STOPPING_MESSAGE
                        )
                    )
            except TransportError as exc:
                _log.debug("resposta de encerramento de %s não enviada (%s)", command.type, exc)
            except Exception:
                _log.exception("falha ao responder %s ao encerrar", command.type)

    def connection_lost(self) -> None:
        """A conexão com a API caiu: o que esperava na faixa do PC é descartado (seria executado
        tarde, depois de a pessoa já ter perdido o controle) e os botões apertados são soltos."""
        self._to_lane(self._lane.connection_lost)

    async def _execute(self, command: Command, reply: Reply | None = None) -> None:
        result = await self._handle_command(command)
        self._remember_result(command, result)
        await self._reply_result(command, result, reply)

    async def _execute_detached(self, command: Command, reply: Reply | None = None) -> None:
        # Ninguém espera esta tarefa: o que der errado no envio só pode ir para o registro.
        try:
            if (
                self._command_timeout is None
                or command.type in self._uncapped_types
                or command.type.startswith(_PC_PREFIX)  # o teto é das teclas da TV
            ):
                await self._execute(command, reply)
            else:
                await self._execute_capped(command, self._command_timeout, reply)
        except TransportError as exc:
            _log.debug("resultado de %s não enviado (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder %s (id=%s)", command.type, command.id)

    async def _execute_capped(
        self, command: Command, limit: float, reply: Reply | None = None
    ) -> None:
        # O corte só vale se foi o prazo que o causou: um `TimeoutError` do próprio comando passa.
        try:
            async with asyncio.timeout(limit) as deadline:
                await self._execute(command, reply)
        except TimeoutError:
            if not deadline.expired():
                raise
        else:
            return
        _log.warning("comando %s passou do tempo máximo (id=%s)", command.type, command.id)
        result = CommandResult(
            command.id, ResultStatus.FAILED, "a TV demorou demais para responder", TV_UNREACHABLE
        )
        self._remember_result(command, result)
        await self._reply_result(command, result, reply)

    async def _reject(self, rejected: Rejected) -> None:
        # Nunca o corpo recebido: só quem enviou o quê (tipo) e por quê.
        _log.warning(
            "mensagem recusada (agente=%s, type=%s, motivo=%s%s)",
            self._agent_id,
            rejected.message_type or "?",
            rejected.reason,
            f": {rejected.detail}" if rejected.detail else "",
        )
        if rejected.reply_to is not None:
            await self._transport.send(
                self._envelopes.result(
                    rejected.reply_to,
                    ok=False,
                    code=INVALID_MESSAGE,
                    message=f"mensagem recusada: {rejected.reason}",
                )
            )


__all__ = [
    "LATE_POINTER_WARNING",
    "MAX_PENDING_PC",
    "MAX_PENDING_RESULTS",
    "Accepted",
    "ProcessMessage",
]
