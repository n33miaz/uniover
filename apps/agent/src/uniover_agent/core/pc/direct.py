"""Canal direto (WebRTC) do controle do PC: um acelerador opcional, com a nuvem como reserva.

O app abre o canal pela API (a oferta e a resposta passam pelo canal autenticado que já existe) e
depois o ponteiro, os cliques, as teclas, o texto e a mídia vão direto ao PC. Nada aqui escolhe
quem pode abrir: quem entrega a oferta é a API, e só ao agente do próprio dono do PC. O que este
módulo garante é o resto:

- a primeira mensagem do canal de entrada precisa levar o token que a API emitiu (uso único, vida
  curta, contada aqui pelo relógio monotônico); sem ele o canal é fechado e o ponteiro não passa;
- as mensagens viram os MESMOS comandos `pc.*` da nuvem: passam pelo mesmo esquema (`EnvelopeGate`),
  pela mesma faixa e pelos mesmos handlers (idade, soltura de botão, registro sem o texto);
- fechar o canal, por qualquer motivo, solta o que o PC ficou segurando e descarta o que dele
  esperava na faixa (como a queda da conexão com a API);
- no máximo um canal por vez: uma oferta nova troca o par;
- sem mensagem por `idle_seconds`, ou sem autenticar a tempo, o canal é fechado.

O ponteiro viaja como TOTAL ACUMULADO com número de sequência, num canal sem retransmissão: a
mensagem perdida não perde caminho (a seguinte traz a soma), a que chega fora de ordem é ignorada.
Cada comando da entrada leva também o total do ponteiro no instante em que foi dado, e o agente o
aplica antes dele: o clique nunca passa na frente do movimento que o antecedeu, mesmo com os dois
canais sendo independentes.
"""

import asyncio
import contextlib
import hmac
import json
import logging
import math
import statistics
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.clock_offset import ClockOffset
from uniover_agent.core.pc.freshness import MAX_COMMAND_AGE_SECONDS
from uniover_agent.core.pc.handlers import MAX_POINTER_DELTA, MAX_SCROLL_DELTA, POINTER_TYPE
from uniover_agent.ports import Transport, TransportError
from uniover_agent.ports.pc_direct import (
    INPUT_CHANNEL,
    POINTER_CHANNEL,
    DirectPeer,
    DirectPeerFactory,
    DirectUnavailable,
    PeerCallbacks,
)

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`, e só depois de a API listá-la em `features`.
PC_RTC_CAPABILITY: Final = "pc.rtc.v1"
OFFER_TYPE: Final = "pc.rtc.offer.v1"
CANDIDATE_TYPE: Final = "pc.rtc.candidate.v1"
CLOSE_TYPE: Final = "pc.rtc.close.v1"
# Os `pc.rtc.*` não entram na faixa do PC: a oferta espera a biblioteca carregar e não pode
# segurar o
# mouse da nuvem.
RTC_TYPES: Final = frozenset({OFFER_TYPE, CANDIDATE_TYPE, CLOSE_TYPE})
# Sem resposta ao comando (a API os manda sem esperar): só a oferta é respondida.
RTC_SILENT_TYPES: Final = frozenset({CANDIDATE_TYPE, CLOSE_TYPE})

# O que o canal de entrada aceita. Energia e abrir favorito (com confirmação e trilha na API) só
# existem pela nuvem.
INPUT_TYPES: Final = frozenset(
    {"pc.click.v1", "pc.key.v1", "pc.key.v2", "pc.text.v1", "pc.media.v1"}
)

# Nenhuma mensagem legítima chega perto disto (o texto vai até 200 caracteres).
MAX_MESSAGE_CHARS: Final = 4096
# Mensagens inválidas seguidas que derrubam o canal.
MAX_VIOLATIONS: Final = 30
# Peças em que um deslocamento acumulado grande é dividido (os limites do contrato são por comando).
MAX_POINTER_CHUNKS: Final = 8
# Quanto o fechamento do par pode levar antes de ser abandonado.
PEER_CLOSE_TIMEOUT_SECONDS: Final = 5.0
# Amostras de RTT guardadas para o resumo ao fechar.
MAX_RTT_SAMPLES: Final = 200

REASON_REQUESTED: Final = "requested"
REASON_REPLACED: Final = "replaced"
REASON_SHUTDOWN: Final = "shutdown"
REASON_DISCONNECTED: Final = "disconnected"
REASON_FAILED: Final = "failed"
REASON_IDLE: Final = "idle"
REASON_CONNECT_TIMEOUT: Final = "connect_timeout"

# Recusas da oferta (`command.result.v1`, código estável).
REFUSED_UNAVAILABLE: Final = "rtc_unavailable"
REFUSED_FAILED: Final = "rtc_failed"

Submit = Callable[[Command, Callable[[CommandResult], None] | None], None]
NotifyClosed = Callable[[str, str], Awaitable[None]]
Record = Callable[[str, str, str], None]


@dataclass(frozen=True, slots=True)
class DirectSettings:
    """Prazos e tetos do canal direto (configuráveis em `agent.toml`)."""

    connect_timeout_seconds: float = 15.0
    idle_seconds: float = 20.0
    max_input_per_second: int = 40
    max_pointer_per_second: int = 240
    tick_seconds: float = 0.5


def _unbound_submit(command: Command, on_result: Callable[[CommandResult], None] | None) -> None:
    raise RuntimeError("o canal direto não foi ligado à faixa do PC")


def _unbound_lost() -> None:
    raise RuntimeError("o canal direto não foi ligado à faixa do PC")


class DirectRefused(Exception):  # noqa: N818 - o nome diz o que aconteceu
    """A oferta não pôde ser atendida; `code` é o código estável devolvido à API."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _Rate:
    """Teto de mensagens por segundo (janela fixa): passou, a mensagem é descartada."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._start = 0.0
        self._count = 0

    def allow(self, now: float) -> bool:
        if now - self._start >= 1.0:
            self._start = now
            self._count = 0
        self._count += 1
        return self._count <= self._limit


@dataclass(slots=True)
class _Session:
    id: str
    token: str
    created: float
    token_deadline: float
    clock: ClockOffset
    input_rate: _Rate
    pointer_rate: _Rate
    peer: DirectPeer | None = None
    authenticated: bool = False
    closed: bool = False
    last_rx: float = 0.0
    violations: int = 0
    pointer_seq: int = 0
    totals: list[int] = field(default_factory=lambda: [0, 0, 0, 0])
    lost_pointers: int = 0
    dropped: int = 0
    messages: int = 0
    rtts: list[int] = field(default_factory=list)
    watchdog: asyncio.Task[None] | None = None


def _iso(milliseconds: float) -> str:
    return (
        datetime.fromtimestamp(milliseconds / 1000.0, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _as_int(value: object) -> int | None:
    """O inteiro de um campo do protocolo; `None` para o que não é (inclusive `True` e `False`)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _bucket(value: float | None, edges: tuple[int, ...]) -> str:
    """Texto fixo por faixa: o registro de diagnóstico junta repetições pelo texto."""
    if value is None:
        return "sem medida"
    for edge in edges:
        if value < edge:
            return f"abaixo de {edge} ms"
    return f"{edges[-1]} ms ou mais"


class PcDirectService:
    """Ciclo de vida do canal direto: uma sessão por vez, validada e ligada à faixa do PC."""

    def __init__(  # noqa: PLR0913 - dependências injetadas, todas necessárias
        self,
        *,
        factory: DirectPeerFactory,
        agent_id: str,
        gate: EnvelopeGate,
        api_clock: ClockOffset,
        notify_closed: NotifyClosed,
        record: Record | None = None,
        settings: DirectSettings | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._agent_id = agent_id
        self._gate = gate
        # A faixa do PC (`ProcessMessage`) nasce depois deste serviço: `bind` a entrega.
        self._submit: Submit = _unbound_submit
        self._direct_lost: Callable[[], None] = _unbound_lost
        self._api_clock = api_clock
        self._notify_closed = notify_closed
        self._record = record
        self._settings = settings or DirectSettings()
        self._monotonic = monotonic
        self._current: _Session | None = None
        self._lifecycle = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()

    def bind(self, submit: Submit, direct_lost: Callable[[], None]) -> None:
        """Liga à faixa do PC: `submit` põe um comando nela; `direct_lost` solta o preso."""
        self._submit = submit
        self._direct_lost = direct_lost

    @property
    def session_id(self) -> str | None:
        """A sessão aberta agora, se há uma."""
        current = self._current
        return current.id if current is not None and not current.closed else None

    @property
    def authenticated(self) -> bool:
        current = self._current
        return current is not None and current.authenticated and not current.closed

    # ---- sinalização (vem da API) -------------------------------------------------------------

    async def open(self, session_id: str, sdp: str, token: str, ttl_seconds: int) -> str:
        """Atende a oferta: troca o par anterior, aplica a oferta e devolve a resposta SDP."""
        async with self._lifecycle:
            if self._current is not None:
                await self._finish(self._current, REASON_REPLACED, notify=False)
            now = self._monotonic()
            session = _Session(
                id=session_id,
                token=token,
                created=now,
                token_deadline=now + ttl_seconds,
                clock=ClockOffset(monotonic=self._monotonic),
                input_rate=_Rate(self._settings.max_input_per_second),
                pointer_rate=_Rate(self._settings.max_pointer_per_second),
                last_rx=now,
            )
            self._current = session
            session.peer = self._factory(
                PeerCallbacks(
                    on_message=lambda channel, text: self._on_message(session, channel, text),
                    on_open=lambda: _log.debug("canal direto aberto (os dois canais de dados)"),
                    on_closed=lambda: self._spawn(self._finish(session, REASON_FAILED)),
                )
            )
            try:
                answer = await session.peer.accept_offer(sdp)
            except DirectUnavailable:
                await self._finish(session, REASON_FAILED, notify=False)
                raise DirectRefused(REFUSED_UNAVAILABLE) from None
            except Exception:
                # Nunca o SDP nem o motivo detalhado da biblioteca: só que falhou.
                _log.warning("oferta do canal direto recusada (a negociação falhou)")
                await self._finish(session, REASON_FAILED, notify=False)
                raise DirectRefused(REFUSED_FAILED) from None
            session.watchdog = asyncio.create_task(self._watch(session))
            return answer

    async def add_candidate(
        self, session_id: str, candidate: str, mid: str | None, index: int | None
    ) -> None:
        session = self._current
        if session is None or session.closed or session.id != session_id or session.peer is None:
            return
        # Os `.local` não se resolvem aqui (a conexão fecha pelo endereço de onde o app chega).
        if ".local" in candidate:
            return
        with contextlib.suppress(Exception):
            await session.peer.add_candidate(candidate, mid, index)

    async def close(self, session_id: str, reason: str = REASON_REQUESTED) -> None:
        """A API (ou o app) fechou o canal: solta o que o PC segurava, sem avisar de volta."""
        session = self._current
        if session is not None and session.id == session_id:
            await self._finish(session, reason, notify=False)

    def api_disconnected(self) -> None:
        """A conexão com a API caiu: o canal não sobrevive à sessão que o autorizou."""
        session = self._current
        if session is not None and not session.closed:
            self._spawn(self._finish(session, REASON_DISCONNECTED, notify=False))

    async def aclose(self) -> None:
        """O agente está encerrando."""
        session = self._current
        if session is not None:
            await self._finish(session, REASON_SHUTDOWN, notify=False)
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ---- o canal ------------------------------------------------------------------------------

    def _on_message(self, session: _Session, channel: str, text: str) -> None:
        if session.closed:
            return
        now = self._monotonic()
        session.last_rx = now
        session.messages += 1
        data = self._parse(session, text)
        if data is None:
            return
        if channel == INPUT_CHANNEL:
            self._on_input(session, data, now)
        elif channel == POINTER_CHANNEL:
            self._on_pointer(session, data, now)

    def _parse(self, session: _Session, text: str) -> dict[str, Any] | None:
        data: object = None
        if isinstance(text, str) and len(text) <= MAX_MESSAGE_CHARS:
            with contextlib.suppress(ValueError, RecursionError):
                data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("k"), str):
            session.violations = 0
            return data
        self._violation(session)
        return None

    def _violation(self, session: _Session) -> None:
        session.violations += 1
        session.dropped += 1
        if session.violations >= MAX_VIOLATIONS:
            _log.warning("canal direto fechado: mensagens inválidas demais")
            self._spawn(self._finish(session, REASON_FAILED))

    def _on_input(self, session: _Session, data: dict[str, Any], now: float) -> None:
        kind = data["k"]
        if not session.authenticated:
            # A primeira mensagem do canal de entrada TEM de ser o `auth` com o token da API.
            if kind == "auth" and self._token_ok(session, data.get("tok"), now):
                session.authenticated = True
                self._send(session, INPUT_CHANNEL, {"k": "ready"})
            else:
                _log.warning("canal direto recusado: a primeira mensagem não trouxe o token válido")
                self._spawn(self._finish(session, REASON_FAILED))
            return
        if kind != "cmd":
            self._violation(session)
            return
        self._on_command(session, data, now)

    @staticmethod
    def _token_ok(session: _Session, token: object, now: float) -> bool:
        if not isinstance(token, str) or now > session.token_deadline:
            return False
        return hmac.compare_digest(token.encode("utf-8"), session.token.encode("utf-8"))

    def _on_command(self, session: _Session, data: dict[str, Any], now: float) -> None:
        command_id = data.get("i")
        message_type = data.get("t")
        body = data.get("b")
        if not isinstance(command_id, str) or not 0 < len(command_id) <= 40:  # noqa: PLR2004
            self._violation(session)
            return

        def refuse(code: str) -> None:
            session.dropped += 1
            self._send(
                session, INPUT_CHANNEL, {"k": "ack", "i": command_id, "ok": False, "c": code}
            )

        if not session.input_rate.allow(now):
            refuse("rate_limited")
            return
        if (
            not isinstance(message_type, str)
            or message_type not in INPUT_TYPES
            or not isinstance(body, dict)
        ):
            refuse("not_allowed")
            return
        # O movimento que antecedeu o comando entra antes dele, mesmo se o ponteiro atrasou.
        snapshot = data.get("p")
        if isinstance(snapshot, dict):
            self._apply_snapshot(session, snapshot, heartbeat=False)
        if self._expired(session, data.get("ts"), message_type, body):
            refuse("expired")
            return
        accepted = self._validate(message_type, body)
        if accepted is None:
            refuse("invalid_message")
            return

        def answered(result: CommandResult) -> None:
            ok = result.status.value == "ok"
            payload: dict[str, Any] = {"k": "ack", "i": command_id, "ok": ok}
            if not ok:
                payload["c"] = result.code or result.status.value
            self._send(session, INPUT_CHANNEL, payload)

        self._submit(accepted.command, answered)

    def _expired(
        self, session: _Session, sent_ms: object, message_type: str, body: dict[str, Any]
    ) -> bool:
        """Idade do comando pelo relógio do app contra o monotônico daqui (como a nuvem faz)."""
        if message_type in ("pc.click.v1", "pc.key.v2") and body.get("action") == "UP":
            return False  # soltar nunca expira (o botão ou o modificador não pode ficar preso)
        if (
            not isinstance(sent_ms, (int, float))
            or isinstance(sent_ms, bool)
            or not math.isfinite(sent_ms)
        ):
            return False
        try:
            age = session.clock.age(_iso(sent_ms))
        except OverflowError, OSError, ValueError:
            return False
        return age is not None and age > MAX_COMMAND_AGE_SECONDS

    def _on_pointer(self, session: _Session, data: dict[str, Any], now: float) -> None:
        if not session.authenticated:
            session.dropped += 1  # nada passa antes do token
            return
        kind = data["k"]
        if kind == "ping":
            self._on_ping(session, data)
            return
        if kind != "ptr":
            self._violation(session)
            return
        if not session.pointer_rate.allow(now):
            session.dropped += 1
            return  # o total acumulado da próxima mensagem cobre o que ficou de fora
        self._apply_snapshot(session, data, heartbeat=data.get("hb") == 1)

    def _on_ping(self, session: _Session, data: dict[str, Any]) -> None:
        sent = data.get("t")
        if isinstance(sent, (int, float)) and not isinstance(sent, bool) and math.isfinite(sent):
            with contextlib.suppress(OverflowError, OSError, ValueError):
                session.clock.observe(_iso(sent))
        rtt = _as_int(data.get("r"))
        if rtt is not None and 0 <= rtt < 60_000:  # noqa: PLR2004
            session.rtts.append(rtt)
            del session.rtts[:-MAX_RTT_SAMPLES]
        self._send(session, POINTER_CHANNEL, {"k": "pong", "n": data.get("n")})

    def _apply_snapshot(self, session: _Session, data: dict[str, Any], *, heartbeat: bool) -> None:
        """Aplica o que falta para chegar ao total do app (`s` número, `x y w h` totais)."""
        seq = _as_int(data.get("s"))
        values = [_as_int(data.get(key)) for key in ("x", "y", "w", "h")]
        totals = [value for value in values if value is not None]
        if seq is None or len(totals) != len(values):
            self._violation(session)
            return
        if seq <= session.pointer_seq:
            return  # repetida, ou chegou depois de uma mais nova: o total dela já foi aplicado
        if session.pointer_seq > 0:
            session.lost_pointers += seq - session.pointer_seq - 1
        session.pointer_seq = seq
        delta = [new - old for new, old in zip(totals, session.totals, strict=True)]
        session.totals = totals
        self._emit_pointer(session, delta, heartbeat=heartbeat)

    def _emit_pointer(self, session: _Session, delta: list[int], *, heartbeat: bool) -> None:
        limits = (MAX_POINTER_DELTA, MAX_POINTER_DELTA, MAX_SCROLL_DELTA, MAX_SCROLL_DELTA)
        if not any(delta):
            if heartbeat:
                self._submit_pointer(session, [0, 0, 0, 0])
            return
        remaining = list(delta)
        for _ in range(MAX_POINTER_CHUNKS):
            chunk = [
                max(-limit, min(limit, value))
                for value, limit in zip(remaining, limits, strict=True)
            ]
            remaining = [value - part for value, part in zip(remaining, chunk, strict=True)]
            self._submit_pointer(session, chunk)
            if not any(remaining):
                return
        session.dropped += 1  # um salto absurdo (acima de 8 comandos): o resto não é aplicado

    def _submit_pointer(self, session: _Session, chunk: list[int]) -> None:
        body: dict[str, Any] = {"dx": chunk[0], "dy": chunk[1]}
        if chunk[2]:
            body["scrollX"] = chunk[2]
        if chunk[3]:
            body["scrollY"] = chunk[3]
        accepted = self._validate(POINTER_TYPE, body)
        if accepted is None:
            session.dropped += 1
            return
        self._submit(accepted.command, None)

    # ---- comandos -----------------------------------------------------------------------------

    def _validate(self, message_type: str, body: dict[str, Any]) -> Accepted | None:
        """Passa pelo portão da nuvem; `None` se o contrato recusa (corpo fora do registro)."""
        envelope = {
            "v": 1,
            "id": str(uuid.uuid7()),
            "type": message_type,
            "source": "api",
            "target": f"agent:{self._agent_id}",
            "ts": self._fresh_stamp(),
            "correlationId": None,
            "body": body,
        }
        outcome = self._gate.check_inbound(json.dumps(envelope))
        if isinstance(outcome, Accepted):
            return outcome
        _log.warning(
            "mensagem do canal direto recusada (type=%s, motivo=%s)", message_type, outcome.reason
        )
        return None

    def _fresh_stamp(self) -> str:
        """Um `ts` de "agora" na escala da API: a conferência de idade dos handlers vê comando novo.

        A idade deste canal já foi conferida (`_expired`); sem a escala da API (sem batimentos)
        qualquer instante serve, porque então nada é medido.
        """
        offset = self._api_clock.offset
        moment = (
            datetime.now(UTC)
            if offset is None
            else datetime.fromtimestamp(self._monotonic() - offset, UTC)
        )
        return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # ---- fim ----------------------------------------------------------------------------------

    async def _watch(self, session: _Session) -> None:
        settings = self._settings
        while not session.closed:
            await asyncio.sleep(settings.tick_seconds)
            now = self._monotonic()
            if not session.authenticated:
                limit = min(
                    settings.connect_timeout_seconds, session.token_deadline - session.created
                )
                if now - session.created > limit:
                    _log.info("canal direto fechado: não abriu a tempo")
                    await self._finish(session, REASON_CONNECT_TIMEOUT)
                    return
            elif now - session.last_rx > settings.idle_seconds:
                _log.info("canal direto fechado: sem mensagens")
                await self._finish(session, REASON_IDLE)
                return

    async def _finish(self, session: _Session, reason: str, *, notify: bool = True) -> None:
        if session.closed:
            return
        session.closed = True
        if self._current is session:
            self._current = None
        watchdog = session.watchdog
        if watchdog is not None and watchdog is not asyncio.current_task():
            watchdog.cancel()
        # Fechar o canal é como a conexão cair: solta o que o PC segurava e o que esperava na faixa.
        # Um canal que nunca autenticou não comandou nada: não há o que soltar (nem por que mexer no
        # que veio pela nuvem).
        if session.authenticated:
            try:
                self._direct_lost()
            except Exception:
                _log.exception("falha ao soltar o que o PC segurava")
        peer = session.peer
        if peer is not None:
            # Com prazo: fechamento que não termina não prende a próxima oferta nem o aviso à API.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(peer.close(), PEER_CLOSE_TIMEOUT_SECONDS)
        self._summarize(session, reason)
        if notify:
            try:
                await self._notify_closed(session.id, reason)
            except Exception:
                _log.debug("aviso de canal fechado não enviado", exc_info=True)

    def _summarize(self, session: _Session, reason: str) -> None:
        """Uma linha de diagnóstico por canal: sem endereço nem SDP, com números em faixas fixas."""
        if self._record is None or not session.authenticated:
            return
        median = statistics.median(session.rtts) if session.rtts else None
        lost = "sem perda" if session.lost_pointers == 0 else "com perda de movimentos"
        self._record(
            "pc.direct_closed",
            "info",
            f"canal direto fechado ({reason}); RTT {_bucket(median, (10, 30, 100, 300))}; {lost}",
        )

    def _send(self, session: _Session, channel: str, payload: dict[str, Any]) -> None:
        peer = session.peer
        if peer is None or session.closed:
            return
        with contextlib.suppress(Exception):
            peer.send(channel, json.dumps(payload, separators=(",", ":")))

    def _spawn(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def pc_rtc_handlers(
    service: PcDirectService, transport: Transport, envelopes: EnvelopeFactory
) -> dict[str, Handler]:
    """Os `pc.rtc.*` que a API manda: a oferta (com a resposta pelo `pc.rtc.answer.v1`), o candidato
    tardio e o fechamento. Não passam pela conferência de idade nem pela faixa do PC."""

    async def offer(command: Command) -> CommandResult:
        body = command.body
        session_id = str(body["sessionId"])
        try:
            answer = await service.open(
                session_id, str(body["sdp"]), str(body["token"]), int(body["tokenTtlSeconds"])
            )
        except DirectRefused as refused:
            return CommandResult(
                command.id, ResultStatus.REJECTED, "canal direto indisponível", refused.code
            )
        try:
            # A resposta sai antes do resultado do comando: a API a espera depois dele, com folga.
            await transport.send(envelopes.pc_rtc_answer(session_id, answer, command.id))
        except TransportError:
            await service.close(session_id, REASON_FAILED)
            return CommandResult(
                command.id, ResultStatus.FAILED, "resposta não enviada", REFUSED_FAILED
            )
        return CommandResult(command.id, ResultStatus.OK)

    async def candidate(command: Command) -> CommandResult:
        body = command.body
        index = body.get("sdpMLineIndex")
        await service.add_candidate(
            str(body["sessionId"]),
            str(body["candidate"]),
            body.get("sdpMid"),
            int(index) if index is not None else None,
        )
        return CommandResult(command.id, ResultStatus.OK)

    async def close(command: Command) -> CommandResult:
        await service.close(str(command.body["sessionId"]), REASON_REQUESTED)
        return CommandResult(command.id, ResultStatus.OK)

    return {OFFER_TYPE: offer, CANDIDATE_TYPE: candidate, CLOSE_TYPE: close}
