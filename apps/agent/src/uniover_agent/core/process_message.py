"""Caso de uso de uma mensagem recebida: valida, executa só o que passou e responde."""

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from functools import partial
from typing import Final

from uniover_agent.core.command_runner import (
    CommandRunner,
    Reply,
    is_power,
)
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
from uniover_agent.core.power_ids import PowerIds
from uniover_agent.core.tv.handlers import POWER_IGNORED
from uniover_agent.core.tv.lane import PATH_CLOUD, TvLane
from uniover_agent.ports import LaneHost, PowerIdStore, Sender, Transport, TransportError

_log = logging.getLogger(__name__)

_KEEPALIVE_TYPE = "api.keepalive.v1"
# O texto do PC: o único `pc.*` cujo `id` repetido é ignorado (ver `_is_repeat`).
_PC_TEXT_PREFIX = "pc.text."
# Comandos do PC têm faixa própria: não esperam as teclas da TV nem as seguram.
_PC_PREFIX = "pc."
# O canal direto (`pc.rtc.*`) é sinalização, não comando de entrada: a oferta espera a biblioteca
# carregar e não pode ficar atrás do mouse da nuvem (nem segurá-lo).
_RTC_PREFIX = "pc.rtc."
# Quanto esperar a faixa do PC ou a da TV (em outro laço) encerrar.
_LANE_CLOSE_SECONDS: Final = 5.0
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
_TV_KEY_PREFIX = "tv.key."
_TEXT_TYPE = "tv.text.v1"
# Os ids que já chegaram, só em memória (~60 KB no máximo): o mesmo id não executa duas vezes.
RECENT_COMMAND_SECONDS: Final = 120.0
RECENT_COMMAND_CAPACITY: Final = 512
# Respostas de comandos repetidos aguardando o envio (fora do leitor): passado o teto, a resposta
# repetida é descartada (o primeiro envio já foi feito; a API reenvia o pedido se ainda precisar).
MAX_PENDING_REPEAT_REPLIES: Final = 64


@dataclass(slots=True)
class _RecentCommand:
    """Quando o id chegou e, depois de terminar, a resposta que ele deu."""

    accepted_at: float
    result: CommandResult | None = None


class ProcessMessage:
    """Valida a mensagem, executa o comando e responde.

    O leitor nunca espera a TV. Teclas, texto, POWER e os outros comandos de entrada
    (`ordered_types`) entram numa cadeia só, em tarefas encadeadas na ordem de chegada: a faixa da
    TV (`TvLane`). Com `tv_host` ela vive no laço próprio da sessão com a TV (uma thread, como a
    entrada do PC) e recebe tudo por `post`, na ordem de chegada; sem ele, aqui mesmo. A manutenção
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
        tv_host: LaneHost | None = None,
        tv_sender: Sender | None = None,
        tv_handle_command: HandleCommand | None = None,
        lane_detached_types: Collection[str] = (),
        direct_active: Callable[[], bool] | None = None,
        ordered_types: Collection[str] = ORDERED_TYPES,
        maintenance_types: Collection[str] = MAINTENANCE_TYPES,
        power_store: PowerIdStore | None = None,
        wall_clock: Callable[[], float] = time.time,
        clock_ns: Callable[[], int] = time.perf_counter_ns,
        notices: Mapping[str, Callable[[Command], None]] | None = None,
    ) -> None:
        self._agent_id = agent_id
        # Avisos da API que não são comando: atendidos no próprio leitor, sem resposta, sem fila
        # (nem a do PC, que exige o aparelho aprovado) e sem contar como uso.
        self._notices: Mapping[str, Callable[[Command], None]] = notices or {}
        self._gate = gate
        self._handle_command = handle_command
        self._envelopes = envelopes
        self._transport = transport
        self._background_types = frozenset(background_types)
        self._silent_types = frozenset(silent_types)
        self._monotonic = monotonic
        self._on_command = on_command
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
        self._ordered_types = frozenset(ordered_types)
        self._maintenance_types = frozenset(maintenance_types)
        # A faixa da manutenção: a última tarefa dela (a próxima espera esta terminar).
        self._last_maintenance_task: asyncio.Task[None] | None = None
        # Os comandos aceitos em tarefa que ainda não terminaram (e quem os responde): ao fechar,
        # os que foram cancelados sem resposta recebem `agent_stopping`.
        self._unanswered: dict[asyncio.Task[None], tuple[Command, Reply | None]] = {}
        self._recent: OrderedDict[str, _RecentCommand] = OrderedDict()
        # `POWER` alterna a TV: os ids dele vão a disco, valem pela hora de parede e sobrevivem a
        # reinício e hibernação (ver `PowerIds`).
        self._power = PowerIds(power_store, wall_clock)
        # Teto de um comando em tarefa própria: uma tecla presa não pode segurar para sempre o
        # texto e o POWER que esperam por ela. Os tipos longos por natureza ficam de fora.
        self._runner = CommandRunner(
            handle_command,
            envelopes,
            transport,
            self._power,
            self._remember_result,
            silent_types=silent_types,
            command_timeout_seconds=command_timeout_seconds,
            uncapped_types=uncapped_types,
        )
        # A faixa da TV executa com os handlers de lá (no laço dela) e responde pelo `tv_sender`,
        # que leva o envio ao laço do transporte quando ela vive noutra thread.
        self._tv_host = tv_host
        self._tv = TvLane(
            CommandRunner(
                tv_handle_command or handle_command,
                envelopes,
                tv_sender or transport,
                self._power,
                self._remember_result,
                silent_types=silent_types,
                command_timeout_seconds=command_timeout_seconds,
                uncapped_types=uncapped_types,
            ),
            tv_handle_command or handle_command,
            monotonic=monotonic,
            clock_ns=clock_ns,
            on_command=on_command,
        )
        # As respostas repetidas saem numa cadeia própria, fora do leitor, na ordem de chegada.
        self._last_repeat_reply: asyncio.Task[None] | None = None
        self._pending_repeat_replies = 0

    async def __call__(self, raw: str | bytes) -> None:  # noqa: PLR0911 - um desvio por caminho
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
        notice = self._notices.get(command.type)
        if notice is not None:
            notice(command)
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
            # Pela nuvem, a idade desde o envio é lida AGORA, na chegada (no laço do leitor), antes
            # de a tecla ir à faixa da TV.
            sent_age = (
                self._timestamp_age(command.sent_at) if self._timestamp_age is not None else None
            )
            self._to_tv(
                partial(self._tv.accept_key, command, self._monotonic(), sent_age, path=PATH_CLOUD)
            )
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

        `POWER` (interruptor) tem lembrança à parte, em disco e pela hora de parede (30 dias, 1000
        ids), sem disputar vaga com as outras teclas: um reenvio tardio, ou depois de um reinício,
        nunca alterna a TV de novo.

        Se o primeiro já terminou, o repetido recebe a mesma resposta; em curso, a resposta do
        primeiro (que leva o mesmo id) serve aos dois. Ficam de fora o fluxo sem resposta (o
        movimento do mouse, dezenas por segundo, empurraria os outros ids para fora) e os `pc.*`,
        entrada que a API nunca reenvia e que a faixa do PC (outro laço) responde por conta própria.
        A exceção é o texto (`pc.text.*`): poucos pedidos, e um trecho colado digitado duas vezes
        estragaria o campo do PC. O repetido é só ignorado: a resposta do primeiro, que a faixa do
        PC manda com o mesmo id, serve aos dois.
        """
        if command.type in self._silent_types or (
            command.type.startswith(_PC_PREFIX) and not command.type.startswith(_PC_TEXT_PREFIX)
        ):
            return False
        if is_power(command):
            return self._is_power_repeat(command)
        now = self._monotonic()
        recent = self._recent
        seconds = RECENT_COMMAND_SECONDS
        capacity = RECENT_COMMAND_CAPACITY
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
            self._reply_repeat(command, previous.result)
        return True

    def _is_power_repeat(self, command: Command) -> bool:
        """`POWER` já aceito (neste processo ou em outro, até 30 dias atrás): nunca executa de novo.

        O id novo entra na memória na hora; a gravação em disco é feita fora do leitor, logo antes
        de a tecla executar (`CommandRunner.execute`).
        """
        if self._power.admit(command.id):
            return False
        _log.info("comando %s repetido ignorado (id=%s)", command.type, command.id)
        result = self._power.result_of(command.id)
        if result is None and self._power.was_restored(command.id):
            # Outro processo o aceitou e não sabemos como terminou: o repetido não executa, e a
            # API não fica esperando (no fio é `ok`, como um POWER ignorado).
            result = CommandResult(command.id, ResultStatus.OK, "", POWER_IGNORED)
        if result is not None:
            self._reply_repeat(command, result)
        return True

    def _reply_repeat(self, command: Command, result: CommandResult) -> None:
        """Manda a resposta de um repetido já concluído sem prender o leitor.

        Um websocket sob pressão faria o `send` esperar, e com ele o leitor: teclas e batimentos
        ficariam na fila e expirariam. A resposta vai numa cadeia (a ordem de chegada vale), com
        teto de pendentes.
        """
        if self._pending_repeat_replies >= MAX_PENDING_REPEAT_REPLIES:
            _log.warning(
                "resposta repetida de %s descartada: envio atrasado (id=%s)",
                command.type,
                command.id,
            )
            return
        self._pending_repeat_replies += 1
        task = asyncio.create_task(self._send_repeat(command, result, self._last_repeat_reply))
        self._last_repeat_reply = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send_repeat(
        self, command: Command, result: CommandResult, previous: asyncio.Task[None] | None
    ) -> None:
        try:
            if previous is not None:
                await asyncio.wait([previous])
            await self._runner.reply_result(command, result)
        except TransportError as exc:
            _log.debug("resposta repetida de %s não enviada (%s)", command.type, exc)
        except Exception:
            _log.exception("falha ao responder o repetido %s (id=%s)", command.type, command.id)
        finally:
            self._pending_repeat_replies -= 1

    def _remember_result(self, command: Command, result: CommandResult) -> None:
        if is_power(command):
            self._power.remember_result(command.id, result)
            return
        entry = self._recent.get(command.id)
        if entry is not None:
            entry.result = result

    def _start_off_reader(self, command: Command) -> bool:
        """Põe o comando numa tarefa (solta, na faixa da TV ou na da manutenção) e diz se pôs. O
        leitor nunca espera por elas."""
        if command.type in self._background_types:
            self._track(asyncio.create_task(self._runner.execute_detached(command)), command, None)
        elif command.type == _TEXT_TYPE:
            self._to_tv(partial(self._tv.accept_text, command))
        elif command.type.startswith(_TV_KEY_PREFIX) or command.type in self._ordered_types:
            self._to_tv(partial(self._tv.accept_ordered, command))
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
        await self._runner.execute_detached(command)

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

    def _to_tv(self, callback: Callable[[], None]) -> None:
        """Entrega à faixa da TV: no laço dela (thread própria) ou, sem ele, agora mesmo."""
        if self._tv_host is None:
            callback()
        else:
            self._tv_host.post(callback)

    @property
    def tv_lane(self) -> TvLane:
        """A faixa das teclas da TV (para quem a liga ao canal direto no laço dela)."""
        return self._tv

    def submit_direct_tv(
        self,
        command: Command,
        received_at: float,
        on_result: Callable[[CommandResult], None],
        is_valid: Callable[[], bool] | None = None,
    ) -> None:
        """Uma tecla ou um texto da TV que chegou pelo canal direto: vai à faixa da TV (ver
        `TvLane.submit_direct`), no laço dela. Seguro de qualquer laço com `tv_host`; sem ele,
        chame no laço principal."""
        self._to_tv(partial(self._tv.submit_direct, command, received_at, on_result, is_valid))

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

        async def tv() -> None:
            # A faixa da TV também: no laço dela, quando tem um.
            if self._tv_host is None:
                await self._tv.drain(grace)
                return
            try:
                await self._tv_host.call(partial(self._tv.drain, grace), wait_seconds=grace + 1.0)
            except TimeoutError, RuntimeError:
                _log.warning("a faixa da TV não terminou o que tinha em curso a tempo")

        await asyncio.gather(own(), lane(), tv())

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
            unanswered = list(self._unanswered.values())
            self._unanswered.clear()
            await self._runner.answer_stopping(unanswered)
        finally:
            await self._close_tv()
            if self._pc_host is None:
                await self._lane.aclose()
            else:
                try:
                    await self._pc_host.call(self._lane.aclose, wait_seconds=_LANE_CLOSE_SECONDS)
                except TimeoutError, RuntimeError:
                    _log.warning("a faixa do PC não encerrou a tempo")

    async def _close_tv(self) -> None:
        """A faixa da TV fecha no laço dela (cancela a fila e responde quem ficou sem resposta)."""
        if self._tv_host is None:
            await self._tv.aclose()
            return
        try:
            await self._tv_host.call(self._tv.aclose, wait_seconds=_LANE_CLOSE_SECONDS)
        except TimeoutError, RuntimeError:
            _log.warning("a faixa da TV não encerrou a tempo")

    def connection_lost(self) -> None:
        """A conexão com a API caiu: o que esperava na faixa do PC é descartado (seria executado
        tarde, depois de a pessoa já ter perdido o controle) e os botões apertados são soltos."""
        self._to_lane(self._lane.connection_lost)

    async def refresh_power_ids(self) -> None:
        """Junta os ids de POWER do disco com os da memória (a passagem sem queda chama ao assumir:
        a execução antiga ainda gravou ids depois de esta nascer). Nunca bloqueia o laço."""
        self._power.merge(await asyncio.to_thread(self._power.read_store))

    async def _execute(self, command: Command, reply: Reply | None = None) -> None:
        await self._runner.execute(command, reply)

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
