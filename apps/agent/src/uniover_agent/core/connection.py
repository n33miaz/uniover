"""Laço de conexão: reconecta com backoff para sempre, mas para quando a credencial é recusada."""

import asyncio
import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import (
    Clock,
    ConnectionReplaced,
    CredentialRejected,
    HandoverRequested,
    HandoverUnsupported,
    NetworkChangeWatcher,
    NetworkChangeWatcherFactory,
    ServerRestarting,
    ServerRestartNow,
    Transport,
    TransportError,
)

_log = logging.getLogger(__name__)

REVOKED_MESSAGE: Final = "token revogado ou inválido; rode `uniover-agent pair`"
# O batimento do agente (era 25 s): com 5 s, a API percebe em poucos segundos um agente que parou
# (PC paginado) sem esperar um comando estourar o prazo. Uma API anterior aceita qualquer ritmo.
APPLICATION_KEEPALIVE_SECONDS: Final = 5.0
# O `hello` volta de tempos em tempos: se a API do momento o recusou (ainda não conhecia um campo
# novo) ou foi trocada com o agente já conectado, ele passa a valer sem reiniciar o agente.
REHELLO_SECONDS: Final = 300.0
RECENT_CONNECTION_SECONDS: Final = 10 * 60.0
RECENT_CONNECTION_CAP_SECONDS: Final = 5.0
# Prazo de cada passo da conexão. O transporte já limita a abertura (105 s, a API dormindo acorda
# em até ~1 min); estes prazos são a segunda barreira: nenhum `await` de rede ou de reanúncio pode
# parar o laço para sempre.
CONNECT_TIMEOUT_SECONDS: Final = 120.0
SEND_TIMEOUT_SECONDS: Final = 60.0
ON_CONNECTED_TIMEOUT_SECONDS: Final = 180.0
CLOSE_TIMEOUT_SECONDS: Final = 15.0
# Cada passo declara até quando deve acabar; este é o atraso a mais que ainda se tolera antes de a
# conexão ser dada por parada (ver `ConnectionSupervisor.is_stalled`).
STALL_GRACE_SECONDS: Final = 120.0
# Duas substituições (`replaced`) em 10 minutos: outra instância viva disputa a conexão.
DUPLICATE_REPLACEMENTS: Final = 2
DUPLICATE_WINDOW_SECONDS: Final = 10 * 60.0
# Por que `ConnectionSupervisor.run` devolveu.
STOP_CREDENTIAL_REJECTED: Final = "credential_rejected"
STOP_HANDOVER: Final = "handover"
STOP_DUPLICATE: Final = "duplicate"
# A API não tem a rota da candidata da passagem (404): nada foi aberto, o supervisor usa o
# caminho de reserva.
# Intervalo mínimo entre duas antecipações da reconexão por aviso de mudança de rede.
NETWORK_WAKE_MIN_SECONDS: Final = 5.0
STOP_HANDOVER_UNSUPPORTED: Final = "handover_unsupported"
# Candidata tirada do lugar (`replaced`) antes de virar dona: volta como candidata e reconecta já.
# Mais de `RECANDIDACY_LIMIT` vezes em `RECANDIDACY_WINDOW_SECONDS` já não é acaso (algo disputa a
# vaga): volta a valer a espera de sempre.
RECANDIDACY_LIMIT: Final = 5
RECANDIDACY_WINDOW_SECONDS: Final = 60.0
# A API confirma que promoveu esta conexão (candidata da passagem): só então deixa de ser candidato.
HANDOVER_ACCEPTED_TYPE: Final = "agent.handover.accepted.v1"


@dataclass(frozen=True, slots=True)
class BackoffPolicy:
    base: float = 1.0
    cap: float = 30.0
    # Quanto a conexão precisa durar para a espera voltar ao início.
    stable_after: float = 60.0
    # Espera depois de `replaced`: outra instância do mesmo agente assumiu; evita disputa.
    replaced_wait: float = 60.0
    # Espera depois de o servidor avisar que reinicia (1012/1001): a API nova sobe em segundos,
    # então volta-se logo, com jitter para uma frota de agentes não bater junta na porta.
    restart_wait: float = 0.5
    # Espera depois do 4411 (a API pediu para reconectar já): sorteada entre os dois extremos,
    # para uma frota de agentes não bater junta na instância nova.
    restart_now_min: float = 0.2
    restart_now_max: float = 0.5
    # Fração de variação para mais e para menos (0,2 = de 80% a 120%).
    jitter: float = 0.2
    # Prazos de cada passo (ver as constantes acima).
    connect_timeout: float = CONNECT_TIMEOUT_SECONDS
    send_timeout: float = SEND_TIMEOUT_SECONDS
    on_connected_timeout: float = ON_CONNECTED_TIMEOUT_SECONDS
    close_timeout: float = CLOSE_TIMEOUT_SECONDS
    stall_grace: float = STALL_GRACE_SECONDS


class Backoff:
    """Espera exponencial com jitter limitado; sem número máximo de tentativas."""

    def __init__(self, policy: BackoffPolicy, random: Callable[[], float]) -> None:
        self._policy = policy
        self._random = random
        self._attempt = 0

    def next_delay(self, cap: float | None = None) -> float:
        ceiling = self._policy.cap if cap is None else min(cap, self._policy.cap)
        raw = min(ceiling, self._policy.base * (2**self._attempt))
        self._attempt = min(self._attempt + 1, 32)
        factor = 1 + self._policy.jitter * (2 * self._random() - 1)
        # O teto vale também depois do jitter.
        return float(min(ceiling, raw * factor))

    def reset(self) -> None:
        self._attempt = 0


class ConnectionSupervisor:
    """Mantém o canal aberto: conecta, anuncia (`agent.hello.v1`), processa e reconecta."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        transport: Transport,
        process_message: Callable[[str | bytes], Awaitable[None]],
        envelopes: EnvelopeFactory,
        clock: Clock,
        random: Callable[[], float],
        *,
        agent_version: str,
        capabilities: Sequence[str] | Callable[[], Sequence[str]],
        policy: BackoffPolicy | None = None,
        on_connected: Callable[[], Awaitable[None]] | None = None,
        on_disconnected: Callable[[], None] | None = None,
        keepalive_interval: float = APPLICATION_KEEPALIVE_SECONDS,
        keepalive_lag_ms: Callable[[], int | None] | None = None,
        rehello_interval: float = REHELLO_SECONDS,
        os_description: str | None = None,
        tv: tuple[str, str] | None = None,
        update_status: Callable[[], dict[str, Any] | None] | None = None,
        on_startup_failure: Callable[[BaseException, bool, int], Awaitable[None]] | None = None,
        handover: bool = False,
        on_handover_accepted: Callable[[], None] | None = None,
        is_owner: Callable[[], bool] | None = None,
        on_handover_restarted: Callable[[], None] | None = None,
        network_watcher: NetworkChangeWatcherFactory | None = None,
    ) -> None:
        """`handover`: esta execução veio tomar o lugar de outra. Ela é CANDIDATA (rota própria da
        conexão e `handover` no `hello`) até a API confirmar a promoção com
        `agent.handover.accepted.v1`; antes disso toda reconexão dela é de novo candidata e nunca
        substitui a antiga por engano. Depois da confirmação ela é uma conexão comum: o `hello`
        deixa de trazer `handover` e `instanceId` (uma API revertida, de contrato fechado, recusaria
        o campo).

        `is_owner` diz se esta execução já é a dona da instalação (a antiga saiu e a trava é dela).
        Uma candidata que recebe `replaced` antes disso (um deploy da API no meio da passagem, uma
        queda curta da antiga) não espera: volta a ser candidata, com o mesmo `instanceId`, e
        reconecta já. Nesse caso `on_handover_restarted` avisa que a confirmação anterior não vale
        mais: quem espera a promoção deve esperar a da nova candidatura."""
        self._transport = transport
        self._process = process_message
        self._envelopes = envelopes
        self._clock = clock
        self._agent_version = agent_version
        # Pode ser uma função: o `hello` (repetido a cada 5 minutos) passa a declarar uma capacidade
        # nova assim que a API disser que a aceita, sem reiniciar o agente.
        self._capabilities = capabilities
        self._policy = policy or BackoffPolicy()
        self._random = random
        self._backoff = Backoff(self._policy, random)
        # Roda a cada conexão, logo depois do `hello` (ex.: informar à API o estado atual da TV).
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        self._keepalive_interval = keepalive_interval
        # O atraso do laço que vai no batimento (`None`: batimento vazio, como numa API anterior).
        self._keepalive_lag_ms = keepalive_lag_ms
        self._rehello_interval = rehello_interval
        # Opcionais do `hello` (sistema do PC; tipo e endereço da TV): só aparecem na tela do dono.
        self._os_description = os_description
        self._tv = tv
        # Lido a cada `hello`: o estado da auto-atualização muda com o tempo.
        self._update_status = update_status
        # Falhas de conexão antes do primeiro `hello` deste processo: a API ainda não ouviu o agente
        # e o laço abaixo as engole. Quem recebe (exceção, se foi inesperada, quantas já houve) pode
        # deixar um rastro para o dono. Nunca é chamado depois do primeiro `hello`.
        self._on_startup_failure = on_startup_failure
        # Passagem sem queda: esta execução veio tomar o lugar de outra e segue candidata (em toda
        # conexão e em todo `hello`) até a confirmação da API: o envio local do `hello` não prova
        # API o leu, e uma queda antes disso faria a reconexão, sem o aviso, substituir a antiga. O
        # identificador é só desta execução.
        self._handover_pending = handover
        self._on_handover_accepted = on_handover_accepted
        self._is_owner = is_owner
        self._on_handover_restarted = on_handover_restarted
        self._recandidated_at: list[float] = []
        # Pedido de parada vindo de fora (`request_stop`): `run` devolve com este motivo.
        self._requested_stop: str | None = None
        self._stop_requested: asyncio.Event | None = None
        self._instance_id = str(uuid.uuid4()) if handover else None
        # Por que o laço parou (`run` devolve): `None` enquanto roda.
        self.stop_reason: str | None = None
        # Quando a API tirou esta execução do lugar por `replaced`, para barrar o laço de disputa.
        self._replaced_at: list[float] = []
        self._hello_done = False
        self._failures_before_hello = 0
        self._in_session = False
        # Até quando o passo atual deve acabar (relógio monotônico): é o que diz se o laço de
        # conexão anda ou está preso (`is_stalled`).
        self._due_at = clock.monotonic()
        # Cada sessão tem um número; uma tarefa abandonada que ignorou o cancelamento vê que a sua
        # passou e sai, em vez de seguir lendo ou enviando no canal da sessão seguinte.
        self._generation = 0
        self._last_connected_at: float | None = None
        self._last_session_seconds = 0.0
        self._network_changed: asyncio.Event | None = None
        self._last_network_wake: float | None = None
        self._network_watcher_factory = network_watcher
        self._network_watcher: NetworkChangeWatcher | None = None

    @property
    def handover_pending(self) -> bool:
        """A API ainda não confirmou a promoção desta execução: a próxima conexão é de candidata."""
        return self._handover_pending

    @property
    def instance_id(self) -> str | None:
        """O identificador desta execução na passagem (`None` fora dela)."""
        return self._instance_id

    def _expect(self, seconds: float) -> None:
        self._due_at = self._clock.monotonic() + seconds

    def is_stalled(self) -> bool:
        """O laço de conexão passou do prazo do passo atual (e da tolerância) sem andar?

        Todo passo tem prazo e o declara antes de começar (`_bounded`, `_sleep`, o batimento), então
        isto só fica verdadeiro quando um prazo foi ignorado, como um fechamento de canal que não
        obedece ao cancelamento. Quem dá o sinal de vida do agente deve parar de dá-lo: um agente
        com a conexão presa parece saudável por outras tarefas e nunca seria reiniciado."""
        return self._clock.monotonic() > self._due_at + self._policy.stall_grace

    async def _sleep(self, seconds: float) -> None:
        self._expect(seconds)
        await self._clock.sleep(seconds)

    async def _sleep_for_reconnect(self, seconds: float) -> None:
        """Espera o backoff comum, mas acorda se o Windows avisar que a rede mudou.

        Só se chega aqui com a conexão caída. O aviso antecipa a tentativa no máximo uma vez por
        `NETWORK_WAKE_MIN_SECONDS` (uma VPN ou um adaptador virtual que oscila não anula o
        backoff), e uma mudança ocorrida antes desta espera, com a conexão saudável, não vale.
        """
        changed = self._network_changed
        if changed is None:
            await self._sleep(seconds)
            return

        changed.clear()
        self._expect(seconds)
        sleeper = asyncio.create_task(self._clock.sleep(seconds), name="reconnect-delay")
        notification: asyncio.Task[bool] | None = None
        try:
            while True:
                notification = asyncio.create_task(changed.wait(), name="network-change")
                done, _ = await asyncio.wait(
                    (sleeper, notification), return_when=asyncio.FIRST_COMPLETED
                )
                if sleeper in done:
                    await sleeper
                    return
                changed.clear()
                now = self._clock.monotonic()
                last = self._last_network_wake
                if last is None or now - last >= NETWORK_WAKE_MIN_SECONDS:
                    self._last_network_wake = now
                    return
                # Cedo demais depois do último despertar: segue esperando o backoff.
        finally:
            tasks = [sleeper] if notification is None else [sleeper, notification]
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def _start_network_watcher(self) -> None:
        loop = asyncio.get_running_loop()

        def on_change() -> None:
            _log.info("a rede mudou")
            changed = self._network_changed
            if changed is not None:
                try:
                    loop.call_soon_threadsafe(changed.set)
                except RuntimeError:
                    # No encerramento do processo o laço já pode ter fechado.
                    return

        factory = self._network_watcher_factory
        if factory is None:
            return
        try:
            watcher = factory(on_change)
        except Exception:
            return
        if watcher is None:
            return
        self._network_changed = asyncio.Event()
        try:
            watcher.start()
        except Exception:
            # A observação é só uma otimização; o backoff normal continua sendo suficiente.
            self._network_changed = None
            return
        self._network_watcher = watcher

    def _stop_network_watcher(self) -> None:
        watcher = self._network_watcher
        self._network_watcher = None
        self._network_changed = None
        if watcher is not None:
            watcher.stop()

    async def hello_now(self) -> None:
        """Reenvia o `hello` já, na sessão aberta (as capacidades declaradas mudaram).

        Sem sessão aberta não faz nada: o `hello` da próxima conexão já sai com o que há de novo.
        """
        if self._in_session:
            # Prazo próprio (sem mexer no que o laço de conexão espera): outra tarefa a chama.
            try:
                async with asyncio.timeout(self._policy.send_timeout):
                    await self._transport.send(self._hello())
            except TimeoutError:
                raise TransportError("o reenvio do hello passou do prazo") from None

    def _declared(self) -> tuple[str, ...]:
        source = self._capabilities
        return tuple(source() if callable(source) else source)

    def _hello(self) -> dict[str, Any]:
        update: dict[str, Any] | None = None
        if self._update_status is not None:
            try:
                update = self._update_status()
            except Exception:
                _log.exception("não consegui ler o estado da atualização")
        try:
            return self._envelopes.hello(
                self._agent_version,
                self._declared(),
                os_description=self._os_description,
                tv=self._tv,
                update=update,
                instance_id=self._hello_instance_id(),
                handover=self._handover_pending,
            )
        except ValueError:
            if update is None:
                raise
            # Sem o estado da atualização o agente ainda conecta, nunca fica fora do ar por ele.
            _log.warning("estado da atualização fora do contrato; o hello segue sem ele")
            return self._envelopes.hello(
                self._agent_version,
                self._declared(),
                os_description=self._os_description,
                tv=self._tv,
                instance_id=self._hello_instance_id(),
                handover=self._handover_pending,
            )

    def _hello_instance_id(self) -> str | None:
        """O identificador da execução só viaja enquanto ela é candidata (o `hello` de passagem)."""
        return self._instance_id if self._handover_pending else None

    def request_stop(self, reason: str) -> None:
        """Manda `run` parar e devolver com `reason`, em qualquer ponto em que ele esteja (numa
        sessão, na espera da reconexão ou na espera do `replaced`). A sessão aberta é fechada como
        no fim normal. Chamado de dentro do laço de eventos."""
        if self._requested_stop is None:
            self._requested_stop = reason
        if self._stop_requested is not None:
            self._stop_requested.set()

    async def run(self) -> None:
        self._start_network_watcher()
        stop = self._stop_requested = asyncio.Event()
        if self._requested_stop is not None:
            stop.set()
        loop_task = asyncio.ensure_future(self._run())
        waiter = asyncio.ensure_future(stop.wait())
        try:
            done, _ = await asyncio.wait({loop_task, waiter}, return_when=asyncio.FIRST_COMPLETED)
            if loop_task in done:
                loop_task.result()
                return
            # Pedido de parada: a sessão em curso é cancelada (o `finally` dela fecha o canal).
            loop_task.cancel()
            await asyncio.gather(loop_task, return_exceptions=True)
            self.stop_reason = self._requested_stop
        finally:
            for task in (loop_task, waiter):
                if not task.done():
                    task.cancel()
            await asyncio.gather(loop_task, waiter, return_exceptions=True)
            self._stop_requested = None
            self._stop_network_watcher()

    async def _run(self) -> None:
        """Roda até ser cancelado; só devolve (sem erro) para parar de vez (ver `stop_reason`):
        a credencial foi recusada, uma versão nova assumiu a conexão (passagem sem queda) ou outro
        agente com a mesma identidade disputa a vaga.

        Quem chamar deve tratar a devolução como "parar": o token continua guardado até o usuário
        decidir (não se apaga sozinho).
        """
        while True:
            try:
                await self._session()
            except CredentialRejected:
                _log.error(REVOKED_MESSAGE)
                self.stop_reason = STOP_CREDENTIAL_REJECTED
                return
            except ConnectionReplaced:
                if self._recandidate():
                    wait = (
                        self._policy.restart_now_min
                        + (self._policy.restart_now_max - self._policy.restart_now_min)
                        * self._random()
                    )
                    _log.warning(
                        "tiraram esta execução do lugar antes de ela virar a dona; volto como "
                        "candidata da passagem em %.1f s",
                        wait,
                    )
                    await self._sleep(wait)
                    continue
                if self._duplicate_detected():
                    _log.error(
                        "outra instância deste agente tomou a conexão duas vezes em %.0f min; "
                        "encerro em vez de disputar",
                        DUPLICATE_WINDOW_SECONDS / 60,
                    )
                    self.stop_reason = STOP_DUPLICATE
                    return
                wait = self._policy.replaced_wait
                _log.warning(
                    "outra instância deste agente assumiu a conexão; nova tentativa em %.0f s", wait
                )
                await self._sleep(wait)
                continue
            except ServerRestartNow as exc:
                wait = (
                    self._policy.restart_now_min
                    + (self._policy.restart_now_max - self._policy.restart_now_min) * self._random()
                )
                _log.info(
                    "conexão perdida após %.1f s: a API pediu reconectar já (%s); volto em %.1f s",
                    self._last_session_seconds,
                    exc,
                    wait,
                )
                await self._sleep(wait)
                continue
            except HandoverUnsupported:
                _log.warning("a API não tem a rota da passagem sem queda; esta execução desiste")
                self.stop_reason = STOP_HANDOVER_UNSUPPORTED
                return
            except HandoverRequested:
                # Uma versão nova conectou e a API a fez dona: esta termina sem reconectar (isso
                # tiraria a nova do lugar).
                _log.info("uma versão nova assumiu a conexão; encerro sem reconectar")
                self.stop_reason = STOP_HANDOVER
                return
            except ServerRestarting as exc:
                # Não cresce a espera: o aviso é do próprio servidor, não falha de rede.
                wait = self._policy.restart_wait * (0.5 + self._random())
                _log.info(
                    "conexão perdida após %.1f s: servidor reiniciando (%s); volto em %.1f s",
                    self._last_session_seconds,
                    exc,
                    wait,
                )
                await self._sleep(wait)
                continue
            except TransportError as exc:
                _log.info("conexão perdida após %.1f s: %s", self._last_session_seconds, exc)
                await self._note_failure(exc, unexpected=False)
            except Exception as exc:
                # Nada que o laço não preveja pode matar o agente: PC ligado há horas e agente fora
                # do ar era exatamente isso. Registra a causa e reconecta com a espera normal.
                _log.exception("falha inesperada na conexão; reconectando")
                await self._note_failure(exc, unexpected=True)
            else:
                _log.info("conexão encerrada pelo servidor após %.1f s", self._last_session_seconds)
            delay = self._backoff.next_delay(self._recent_connection_cap())
            _log.info("reconectando em %.1f s", delay)
            await self._sleep_for_reconnect(delay)

    def _recandidate(self) -> bool:
        """A candidata da passagem foi tirada do lugar antes de ser dona: vale voltar já a ser
        candidata (mesmo `instanceId`)? Não vale depois da posse (a espera de sempre protege contra
        a disputa) nem se isso se repete demais."""
        if self._instance_id is None or self._is_owner is None or self._is_owner():
            return False
        now = self._clock.monotonic()
        self._recandidated_at = [
            moment for moment in self._recandidated_at if now - moment < RECANDIDACY_WINDOW_SECONDS
        ]
        if len(self._recandidated_at) >= RECANDIDACY_LIMIT:
            return False
        self._recandidated_at.append(now)
        # A API pode já ter confirmado a promoção: o que vale agora é a da nova conexão.
        self._handover_pending = True
        if self._on_handover_restarted is not None:
            self._on_handover_restarted()
        return True

    def _duplicate_detected(self) -> bool:
        """Duas substituições seguidas em pouco tempo: há outro agente vivo com a mesma identidade.

        Esperar 60 s e reconectar só tiraria o outro do lugar, e ele faria o mesmo comigo."""
        now = self._clock.monotonic()
        self._replaced_at = [
            moment for moment in self._replaced_at if now - moment < DUPLICATE_WINDOW_SECONDS
        ]
        self._replaced_at.append(now)
        return len(self._replaced_at) >= DUPLICATE_REPLACEMENTS

    def _recent_connection_cap(self) -> float | None:
        connected = self._last_connected_at
        if connected is None or self._clock.monotonic() - connected >= RECENT_CONNECTION_SECONDS:
            return None
        return RECENT_CONNECTION_CAP_SECONDS

    async def _note_failure(self, exc: BaseException, *, unexpected: bool) -> None:
        if self._hello_done or self._on_startup_failure is None:
            return
        self._failures_before_hello += 1
        try:
            await self._bounded(
                self._on_startup_failure(exc, unexpected, self._failures_before_hello),
                self._policy.send_timeout,
                "o rastro da falha de conexão",
            )
        except Exception:
            _log.warning("não consegui deixar o rastro da falha de conexão", exc_info=True)

    async def _bounded[T](self, step: Awaitable[T], seconds: float, what: str) -> T:
        """`step` com prazo: estourar vira `TransportError`, e o laço reconecta."""
        self._expect(seconds)
        try:
            async with asyncio.timeout(seconds):
                return await step
        except TimeoutError:
            raise TransportError(f"{what} passou de {seconds:.0f} s") from None

    async def _session(self) -> None:
        started: float | None = None
        tasks: list[asyncio.Task[None]] = []
        self._generation += 1
        mine = self._generation
        try:
            await self._bounded(
                self._transport.connect(), self._policy.connect_timeout, "a abertura"
            )
            started = self._clock.monotonic()
            _log.info("conectado")
            await self._bounded(
                self._transport.send(self._hello()), self._policy.send_timeout, "o envio do hello"
            )
            self._last_connected_at = self._clock.monotonic()
            self._hello_done = True
            self._in_session = True
            if self._on_connected is not None:
                await self._bounded(
                    self._on_connected(),
                    self._policy.on_connected_timeout,
                    "o anúncio depois da conexão",
                )
            keepalive = asyncio.create_task(self._send_keepalives(mine), name="keepalive")
            reader = asyncio.create_task(self._read(mine), name="reader")
            tasks = [keepalive, reader]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if reader.done():
                reader.result()
                return
            # O batimento acabou antes da leitura: não consegue mais enviar. A leitura pode estar
            # parada num canal meio morto, então a sessão termina aqui (o `finally` cancela a
            # leitura e fecha o canal, com prazo) e o laço reconecta.
            failure = keepalive.exception()
            if failure is not None:
                _log.warning("o batimento não saiu (%s); reconecto", type(failure).__name__)
                raise failure
        finally:
            self._in_session = False
            # Antes de tudo: o que ficar para trás (ignorando o cancelamento) sai por conta própria.
            self._generation += 1
            await self._stop(tasks)
            if started is not None:
                self._last_session_seconds = max(0.0, self._clock.monotonic() - started)
                if self._last_session_seconds >= self._policy.stable_after:
                    self._backoff.reset()
            await self._close_channel()
            if self._on_disconnected is not None:
                self._on_disconnected()

    async def _read(self, generation: int) -> None:
        async for raw in self._transport.incoming():
            if generation != self._generation:
                return
            if self._take_handover_accepted(raw):
                continue
            await self._process(raw)

    def _take_handover_accepted(self, raw: str | bytes) -> bool:
        """A confirmação da promoção (não segue para o resto do agente). Só vale com o `instanceId`
        execução, vinda da API; a de outra execução, ou fora de hora, é descartada."""
        if isinstance(raw, bytes):
            if HANDOVER_ACCEPTED_TYPE.encode("ascii") not in raw:
                return False
        elif HANDOVER_ACCEPTED_TYPE not in raw:
            return False
        try:
            message = json.loads(raw)
        except ValueError:
            return False
        if not isinstance(message, dict) or message.get("type") != HANDOVER_ACCEPTED_TYPE:
            return False
        body = message.get("body")
        if (
            self._handover_pending
            and message.get("source") == "api"
            and isinstance(body, dict)
            and body.get("instanceId") == self._instance_id
        ):
            self._handover_pending = False
            _log.info("a API promoveu esta execução: a passagem foi confirmada")
            if self._on_handover_accepted is not None:
                self._on_handover_accepted()
        return True

    async def _stop(self, tasks: list[asyncio.Task[None]]) -> None:
        """Cancela as tarefas da sessão e espera por elas, com prazo: uma que ignore o
        cancelamento é abandonada, nunca espera-se por ela para sempre."""
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        self._expect(self._policy.close_timeout)
        _, pending = await asyncio.wait(tasks, timeout=self._policy.close_timeout)
        for task in tasks:
            if task.done() and not task.cancelled():
                task.exception()  # lida: não sobra "exceção nunca recuperada"
        if pending:
            _log.warning("%d tarefa(s) da sessão não obedeceram ao cancelamento", len(pending))

    async def _close_channel(self) -> None:
        """Fecha o canal, com prazo: um fechamento que não volta não prende o laço de conexão."""
        try:
            await self._bounded(
                self._transport.close(), self._policy.close_timeout, "o fechamento do canal"
            )
        except TransportError as exc:
            # Não esconde o erro que trouxe a sessão até aqui: o canal fica abandonado.
            _log.warning("%s", exc)

    async def _send_keepalives(self, generation: int) -> None:
        last_hello = self._clock.monotonic()
        while generation == self._generation:
            self._expect(self._keepalive_interval)
            await asyncio.sleep(self._keepalive_interval)
            if generation != self._generation:
                return
            lag_ms = self._keepalive_lag_ms() if self._keepalive_lag_ms is not None else None
            await self._bounded(
                self._transport.send(self._envelopes.keepalive(lag_ms)),
                self._policy.send_timeout,
                "o batimento",
            )
            if self._clock.monotonic() - last_hello >= self._rehello_interval:
                last_hello = self._clock.monotonic()
                await self._bounded(
                    self._transport.send(self._hello()),
                    self._policy.send_timeout,
                    "o hello periódico",
                )
