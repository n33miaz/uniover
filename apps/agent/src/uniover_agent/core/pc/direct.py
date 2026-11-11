"""Canal direto (WebRTC) do controle do PC: um acelerador opcional, com a nuvem como reserva.

O app abre o canal pela API (a oferta e a resposta passam pelo canal autenticado que já existe) e
depois o ponteiro, os cliques, as teclas, o texto e a mídia vão direto ao PC. Nada aqui escolhe
quem pode abrir: quem entrega a oferta é a API, e só ao agente do próprio dono do PC. O que este
módulo garante é o resto:

- a primeira mensagem do canal de entrada precisa levar o token que a API emitiu (uso único, vida
  curta, contada aqui pelo relógio monotônico); sem ele o canal é fechado e o ponteiro não passa;
- o canal tem vida máxima (a API a tira do que resta do token de acesso da pessoa): ele nunca vive
  mais que a sessão que o autorizou, e a API o fecha na hora se a sessão, a senha, a conta ou a
  permissão da pessoa deixam de valer;
- as mensagens viram os MESMOS comandos `pc.*` da nuvem: passam pelo mesmo esquema (`EnvelopeGate`),
  pela mesma faixa e pelos mesmos handlers (idade, soltura de botão, registro sem o texto);
- fechar o canal, por qualquer motivo, solta o que o PC ficou segurando e descarta o que dele
  esperava na faixa (como a queda da conexão com a API);
- no máximo um canal por vez: uma oferta nova troca o par;
- chegou comando de entrada pela nuvem enquanto o canal em uso existe: o canal fecha PRIMEIRO, de
  modo que um aperto atrasado do canal nunca cai depois de um soltar da nuvem;
- sem mensagem por `idle_seconds`, sem autenticar a tempo ou além da vida máxima, o canal é fechado.

O ponteiro viaja como TOTAL ACUMULADO com número de sequência, num canal sem retransmissão: a
mensagem perdida não perde caminho (a seguinte traz a soma), a que chega fora de ordem é ignorada.
Cada comando da entrada leva também o total do ponteiro no instante em que foi dado, e o agente o
aplica antes dele: o clique nunca passa na frente do movimento que o antecedeu, mesmo com os dois
canais sendo independentes.

A idade de um comando é medida como a da nuvem faz, só que com os sinais de vida do próprio canal
(`ping` no canal do ponteiro, que nunca espera atrás de um comando): a escala de relógio do app
contra o monotônico daqui. Sem essa escala (os dois primeiros sinais ainda não vieram) nenhum
comando de entrada é aceito, exceto o que solta (`UP`), que passa sempre.
"""

import asyncio
import contextlib
import hmac
import json
import logging
import math
import re
import statistics
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.pc.clock_offset import ClockOffset
from uniover_agent.core.pc.devices import (
    DEVICE_DENIED,
    DEVICE_PENDING,
    DEVICE_UNKNOWN,
    DeviceApprovals,
    DeviceDecision,
)
from uniover_agent.core.pc.freshness import MAX_COMMAND_AGE_SECONDS
from uniover_agent.core.pc.handlers import MAX_POINTER_DELTA, MAX_SCROLL_DELTA, POINTER_TYPE
from uniover_agent.core.pc.lan import candidate_is_lan
from uniover_agent.ports import Sender, TransportError
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
# Os `pc.rtc.*` não entram na faixa do PC: a oferta espera a biblioteca carregar e não pode segurar
# o mouse da nuvem.
RTC_TYPES: Final = frozenset({OFFER_TYPE, CANDIDATE_TYPE, CLOSE_TYPE})
# Sem resposta ao comando (a API os manda sem esperar): só a oferta é respondida.
RTC_SILENT_TYPES: Final = frozenset({CANDIDATE_TYPE, CLOSE_TYPE})

# O que o canal de entrada aceita. Energia e abrir favorito (com confirmação e trilha na API) só
# existem pela nuvem.
INPUT_TYPES: Final = frozenset(
    {
        "pc.click.v1",
        "pc.click.v2",
        "pc.key.v1",
        "pc.key.v2",
        "pc.text.v1",
        "pc.text.v2",
        "pc.media.v1",
        # O zoom da pinça e o volume absoluto: a mesma validação, idade, taxa e fila das demais.
        "pc.pointer.zoom.v1",
        "pc.volume.v1",
    }
)
# As mensagens v2 do canal de entrada: o `ready` as lista, e o app só as manda a quem as lista.
CHANNEL_V2_TYPES: Final = frozenset(
    {"pc.click.v2", "pc.text.v2", "pc.pointer.zoom.v1", "pc.volume.v1"}
)
# O que, chegando pela nuvem, fecha o canal em uso: os comandos de entrada (clique, tecla, texto,
# mídia e segurar). O movimento do mouse NÃO está aqui: ele chega sem espera (a API responde antes
# de o agente o ler), então um movimento atrasado da nuvem é normal logo depois da troca de caminho,
# e é só somado.
CLOUD_INPUT_TYPES: Final = INPUT_TYPES

# Nenhuma mensagem legítima chega perto disto (o texto vai até 200 caracteres).
MAX_MESSAGE_CHARS: Final = 4096
# Mensagens inválidas (JSON ruim ou JSON bom com conteúdo recusado) sem nenhuma aceita no meio.
MAX_VIOLATIONS: Final = 30
# Peças em que um deslocamento acumulado grande é dividido (os limites do contrato são por comando).
MAX_POINTER_CHUNKS: Final = 8
# Quanto o fechamento do par pode levar antes de ser abandonado.
PEER_CLOSE_TIMEOUT_SECONDS: Final = 5.0
# Tempo para o `bye` (o aviso do motivo) sair antes de o par ser fechado.
BYE_FLUSH_SECONDS: Final = 0.1
# Amostras de RTT guardadas para o resumo ao fechar.
MAX_RTT_SAMPLES: Final = 200
# O maior `repeat` do contrato do `pc.key.v2`.
MAX_KEY_REPEAT: Final = 50
# O maior `erase` do contrato do `pc.text.v2`.
MAX_ERASE: Final = 200
# O pedido mais pesado que o contrato aceita em apertos de tecla: apagar o máximo e apertar a tecla
# do fim. O balde das teclas nunca é menor que isto, ou um pedido válido seria recusado só
# pelo canal.
MAX_PRESSES_PER_REQUEST: Final = MAX_ERASE + 1
# O maior `seq` que o contrato aceita nos pedidos de entrada da nuvem.
MAX_CLOUD_SEQ: Final = 2_147_483_647
# A época de uma página: 16 hexadecimais sorteados quando ela abre (o mesmo formato do contrato).
_EPOCH_PATTERN: Final = re.compile(r"[0-9a-f]{16}")
# O código de um comando do app (`i`): 1 a 40 letras, números, `_` e `-` (a operação do registro).
_COMMAND_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{1,40}")

REASON_REQUESTED: Final = "requested"
REASON_REPLACED: Final = "replaced"
REASON_SHUTDOWN: Final = "shutdown"
REASON_DISCONNECTED: Final = "disconnected"
REASON_FAILED: Final = "failed"
REASON_IDLE: Final = "idle"
REASON_CONNECT_TIMEOUT: Final = "connect_timeout"
REASON_LIFETIME: Final = "lifetime"
REASON_REVOKED: Final = "revoked"
REASON_CLOUD: Final = "cloud"
# Os motivos que o contrato aceita em `pc.rtc.close.v1` (a API manda) e em `pc.rtc.closed.v1`.
KNOWN_REASONS: Final = frozenset(
    {
        REASON_REQUESTED,
        REASON_REPLACED,
        REASON_SHUTDOWN,
        REASON_DISCONNECTED,
        REASON_FAILED,
        REASON_IDLE,
        REASON_CONNECT_TIMEOUT,
        REASON_LIFETIME,
        REASON_REVOKED,
        REASON_CLOUD,
    }
)

# Recusas da oferta (`command.result.v1`, código estável).
REFUSED_UNAVAILABLE: Final = "rtc_unavailable"
REFUSED_FAILED: Final = "rtc_failed"
# O fechamento daquela sessão chegou antes da oferta (ou durante ela): nenhum canal nasce de uma
# sessão que a API já mandou fechar.
REFUSED_CLOSED: Final = "rtc_closed"

# Quantas sessões fechadas o agente lembra, e por quanto tempo além da vida máxima de um canal.
MAX_TOMBSTONES: Final = 64
TOMBSTONE_MARGIN_SECONDS: Final = 60.0

Submit = Callable[[Command, Callable[[CommandResult], None] | None], None]
NotifyClosed = Callable[[str, str], Awaitable[None]]
Record = Callable[[str, str, str], None]

_UNREACHABLE_HINT: Final = (
    "o app negociou o canal direto mas nenhum pacote dele chegou a este PC: confira o Firewall do "
    "Windows (rede em perfil Público sem regra de entrada para o Python) e se a rede isola os "
    "aparelhos entre si; o app seguiu pela nuvem"
)


@dataclass(frozen=True, slots=True)
class DirectSettings:
    """Prazos e tetos do canal direto (configuráveis em `agent.toml`)."""

    connect_timeout_seconds: float = 15.0
    idle_seconds: float = 20.0
    # Teto da vida de um canal, qualquer que seja o pedido da API (a vida do token de acesso).
    max_lifetime_seconds: float = 900.0
    accept_timeout_seconds: float = 12.0
    max_input_per_second: int = 40
    max_pointer_per_second: int = 240
    # Soltar (`UP`) tem balde próprio e largo: nunca disputa vaga com os apertos.
    max_release_per_second: int = 200
    # O mesmo orçamento da nuvem: umas 100 teclas por segundo em média, contando cada repetição e
    # cada apagado, num balde que comporta um rajada (o pedido mais pesado do contrato, 201 apertos,
    # cabe sempre: ver `MAX_PRESSES_PER_REQUEST`).
    max_presses_per_second: int = 100
    max_press_burst: int = 250
    max_text_chars_per_second: int = 600
    tick_seconds: float = 0.5
    # Quanto o canal sobrevive à queda da conexão com a API: ele não depende da nuvem para andar,
    # mas sem a API (que o fecha na revogação) não vale ficar aberto sem prazo.
    api_grace_seconds: float = 30.0


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
    """Teto por segundo (janela fixa): passou, a mensagem é descartada. `cost` é o peso dela.

    Só o que passa é cobrado: a mensagem recusada não gasta a janela (senão uma recusa tiraria a
    vaga da seguinte, que caberia).
    """

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._start = 0.0
        self._count = 0

    def _roll(self, now: float) -> None:
        if now - self._start >= 1.0:
            self._start = now
            self._count = 0

    def can(self, now: float, cost: int = 1) -> bool:
        self._roll(now)
        return self._count + cost <= self._limit

    def charge(self, now: float, cost: int = 1) -> None:
        self._roll(now)
        self._count += cost

    def allow(self, now: float, cost: int = 1) -> bool:
        if not self.can(now, cost):
            return False
        self.charge(now, cost)
        return True


class _Bucket:
    """Balde contínuo: enche `rate` por segundo até `burst`, e cada mensagem tira o peso dela.

    Serve às teclas apertadas: o pedido mais pesado que o contrato aceita (apagar 200 e apertar a
    tecla do fim) cabe sempre num balde cheio, então nenhum pedido válido é recusado só por ser
    grande; o que passa da média é que espera. A mensagem recusada não gasta nada.
    """

    def __init__(self, rate: int, burst: int) -> None:
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._at: float | None = None

    def _fill(self, now: float) -> None:
        if self._at is not None and now > self._at:
            self._tokens = min(float(self._burst), self._tokens + (now - self._at) * self._rate)
        self._at = now if self._at is None else max(self._at, now)

    def can(self, now: float, cost: int = 1) -> bool:
        self._fill(now)
        return self._tokens >= cost

    def charge(self, now: float, cost: int = 1) -> None:
        self._fill(now)
        self._tokens = max(0.0, self._tokens - cost)

    def allow(self, now: float, cost: int = 1) -> bool:
        if not self.can(now, cost):
            return False
        self.charge(now, cost)
        return True


@dataclass(slots=True)
class _Session:
    id: str
    token: str
    created: float
    token_deadline: float
    lifetime: float
    clock: ClockOffset
    input_rate: _Rate
    press_rate: _Bucket
    text_rate: _Rate
    release_rate: _Rate
    pointer_rate: _Rate
    peer: DirectPeer | None = None
    # Os dois canais de dados abriram (o app chegou a este PC).
    opened: bool = False
    authenticated: bool = False
    # Já comandou alguma coisa (movimento ou comando): só então um comando da nuvem o fecha.
    used: bool = False
    # O último número (`seq`) de pedido de entrada da nuvem que o app diz ter emitido antes de usar
    # o canal (`cs` do `auth` e dos comandos): o que a nuvem entrega com número até aqui é anterior
    # à troca de caminho e não fecha o canal.
    cloud_marker: int | None = None
    # A época da página que numerou esses pedidos (`ce`): um `seq` só vale ao lado dela, porque uma
    # página reaberta recomeça a contagem do zero.
    cloud_epoch: str | None = None
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
    # Quando os dois canais de dados abriram e quando o app se autenticou (monotônico).
    opened_at: float | None = None
    ready_at: float | None = None


def _iso(milliseconds: float) -> str:
    return (
        datetime.fromtimestamp(milliseconds / 1000.0, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _as_int(value: object) -> int | None:
    """O inteiro de um campo do protocolo; `None` para o que não é (inclusive `True` e `False`)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _as_millis(value: object) -> float | None:
    """O instante (ms) de um campo do protocolo; `None` se não é um número finito."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _is_release(message_type: str, body: dict[str, Any]) -> bool:
    """Soltar um botão ou um modificador: nunca expira e nunca espera vaga no limite."""
    return message_type in ("pc.click.v1", "pc.key.v2") and body.get("action") == "UP"


def _press_cost(message_type: str, body: dict[str, Any]) -> int:
    """Quantas teclas o comando aperta: `repeat` conta cada aperto, e na edição de texto cada
    Backspace (`erase`) e a tecla do fim (o mesmo orçamento da nuvem; o texto puro paga um)."""
    if message_type == "pc.text.v2":
        erase = _as_int(body.get("erase"))
        presses = (max(0, min(MAX_ERASE, erase)) if erase is not None else 0) + (
            1 if body.get("key") is not None else 0
        )
        return max(1, presses)
    if message_type != "pc.key.v2":
        return 1
    repeat = _as_int(body.get("repeat"))
    return max(1, min(MAX_KEY_REPEAT, repeat)) if repeat is not None else 1


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
        devices: DeviceApprovals | None = None,
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
        self._devices = devices
        self._current: _Session | None = None
        # As sessões que fecharam (id -> instante): uma oferta delas que chegue depois do fechamento
        # é recusada. O `pc.rtc.offer` espera a biblioteca carregar em tarefa própria e o `close` da
        # API pode passar na frente dele.
        self._closed_ids: dict[str, float] = {}
        self._lifecycle = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        # A espera da volta da conexão com a API (a queda curta não fecha o canal).
        self._grace: asyncio.Task[None] | None = None

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

    @property
    def holds_inputs(self) -> bool:
        """Há um canal autenticado que já comandou algo: o que o PC segura agora é dele."""
        current = self._current
        return current is not None and current.authenticated and current.used and not current.closed

    # ---- sinalização (vem da API) -------------------------------------------------------------

    async def open(  # noqa: PLR0913 - a oferta traz o aparelho e os prazos
        self,
        session_id: str,
        sdp: str,
        token: str,
        ttl_seconds: int,
        max_lifetime_seconds: int | None = None,
        *,
        device_id: str | None = None,
        device_name: str | None = None,
    ) -> str:
        """Atende a oferta: troca o par anterior, aplica a oferta e devolve a resposta SDP.

        De um aparelho que o dono não aprovou no PC (ou recusou) a oferta é recusada, e o app segue
        pela nuvem, que também o recusa."""
        if self._devices is not None:
            decision = self._devices.check(device_id, device_name)
            if decision is not DeviceDecision.APPROVED:
                raise DirectRefused(
                    {
                        DeviceDecision.DENIED: DEVICE_DENIED,
                        DeviceDecision.UNKNOWN: DEVICE_UNKNOWN,
                    }.get(decision, DEVICE_PENDING)
                )
        settings = self._settings
        lifetime = settings.max_lifetime_seconds
        if max_lifetime_seconds is not None:
            lifetime = min(lifetime, float(max_lifetime_seconds))
        async with self._lifecycle:
            if self._was_closed(session_id):
                raise DirectRefused(REFUSED_CLOSED)
            if self._current is not None:
                await self._finish(self._current, REASON_REPLACED, notify=False)
            now = self._monotonic()
            session = _Session(
                id=session_id,
                token=token,
                created=now,
                token_deadline=now + ttl_seconds,
                lifetime=lifetime,
                clock=ClockOffset(monotonic=self._monotonic),
                input_rate=_Rate(settings.max_input_per_second),
                press_rate=_Bucket(
                    settings.max_presses_per_second,
                    max(settings.max_press_burst, MAX_PRESSES_PER_REQUEST),
                ),
                text_rate=_Rate(settings.max_text_chars_per_second),
                release_rate=_Rate(settings.max_release_per_second),
                pointer_rate=_Rate(settings.max_pointer_per_second),
                last_rx=now,
            )
            self._current = session
            session.peer = self._factory(
                PeerCallbacks(
                    on_message=lambda channel, text: self._on_message(session, channel, text),
                    on_open=lambda: self._on_peer_open(session),
                    on_closed=lambda: self._spawn(self._finish(session, REASON_FAILED)),
                )
            )
            try:
                # Com prazo: negociação que não termina nunca prende o `lifecycle`.
                answer = await asyncio.wait_for(
                    session.peer.accept_offer(sdp), settings.accept_timeout_seconds
                )
            except DirectUnavailable:
                await self._finish(session, REASON_FAILED, notify=False)
                raise DirectRefused(REFUSED_UNAVAILABLE) from None
            except Exception:
                # Nunca o SDP nem o motivo da biblioteca: só que falhou (ou passou do prazo).
                _log.warning(
                    "oferta do canal direto recusada (a negociação falhou ou passou do prazo)"
                )
                await self._finish(session, REASON_FAILED, notify=False)
                raise DirectRefused(REFUSED_FAILED) from None
            if session.closed:
                # Mandaram fechar enquanto a oferta era atendida: a resposta não serve a ninguém.
                raise DirectRefused(REFUSED_CLOSED)
            session.watchdog = asyncio.create_task(self._watch(session))
            return answer

    async def add_candidate(
        self, session_id: str, candidate: str, mid: str | None, index: int | None
    ) -> None:
        session = self._current
        if session is None or session.closed or session.id != session_id or session.peer is None:
            return
        # Só UDP de endereço da rede local: nome (inclusive `.local`, que não se resolve aqui),
        # endereço público, TCP e `relay` ficam de fora. O candidato nunca vai ao registro.
        if not candidate_is_lan(candidate):
            _log.debug("candidato tardio recusado: não é UDP de endereço da rede local")
            return
        with contextlib.suppress(Exception):
            await session.peer.add_candidate(candidate, mid, index)

    async def close(self, session_id: str, reason: str = REASON_REQUESTED) -> None:
        """A API (ou o app) fechou o canal: solta o que o PC segurava, sem avisar de volta."""
        # Qualquer fechamento que a API manda vale também para uma oferta do mesmo id que ainda
        # venha (ela espera em tarefa própria e pode chegar depois dele).
        self._remember_closed(session_id)
        session = self._current
        if session is not None and session.id == session_id:
            await self._finish(
                session, reason if reason in KNOWN_REASONS else REASON_REQUESTED, notify=False
            )

    def api_disconnected(self) -> None:
        """A conexão com a API caiu: o canal segue por `api_grace_seconds` e fecha se não voltar.

        O canal direto existe para não depender da nuvem, e uma queda curta (publicação, troca de
        rede) não deve derrubar um arrasto. A vida máxima do canal (o que resta do token de acesso)
        continua valendo; a revogação chega pela API e fecha na hora quando ela está de volta.
        """
        session = self._current
        if session is None or session.closed:
            return
        self._cancel_grace()
        _log.info(
            "conexão com a API caiu; o canal direto segue por até %.0f s", self._grace_seconds()
        )
        self._grace = asyncio.ensure_future(self._grace_then_close(session))

    def api_reconnected(self) -> None:
        """A conexão com a API voltou: o canal que ficou aberto segue sem prazo extra."""
        if self._grace is not None:
            self._cancel_grace()
            _log.info("conexão com a API voltou; o canal direto seguiu aberto")

    def _grace_seconds(self) -> float:
        return self._settings.api_grace_seconds

    def _cancel_grace(self) -> None:
        grace, self._grace = self._grace, None
        if grace is not None and grace is not asyncio.current_task():
            grace.cancel()

    async def _grace_then_close(self, session: _Session) -> None:
        await asyncio.sleep(self._grace_seconds())
        if self._grace is asyncio.current_task():
            self._grace = None
        if not session.closed:
            _log.info("a conexão com a API não voltou a tempo; fechando o canal direto")
            await self._finish(session, REASON_DISCONNECTED, notify=False)

    def cloud_input(
        self, message_type: str, seq: int | None = None, epoch: str | None = None
    ) -> None:
        """Chegou comando de entrada pela nuvem: o canal em uso fecha ANTES de ele ir à faixa.

        Síncrono de propósito: a sessão é dada como fechada e o que o PC segurava é solto já, então
        nada que ainda venha pelo canal (um aperto atrasado) cai depois do que a nuvem vai fazer. O
        resto (avisar o app, fechar o par) segue em tarefa. Um canal que nunca comandou nada fica.

        O movimento do mouse nunca fecha o canal. Um comando com `seq` até o último que o app
        declarou ao trocar de caminho é anterior à troca (a nuvem o entregou tarde): segue para a
        faixa como sempre, mas o canal fica.
        """
        if message_type not in CLOUD_INPUT_TYPES:
            return
        session = self._current
        if session is None or session.closed or not session.used:
            return
        marker = session.cloud_marker
        same_page = epoch is not None and epoch == session.cloud_epoch
        if same_page and seq is not None and marker is not None and seq <= marker:
            return
        self._halt(session)
        self._spawn(self._dispose(session, REASON_CLOUD, notify=True))

    async def aclose(self) -> None:
        """O agente está encerrando."""
        session = self._current
        if session is not None:
            await self._finish(session, REASON_SHUTDOWN, notify=False)
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ---- o canal ------------------------------------------------------------------------------

    def _on_peer_open(self, session: _Session) -> None:
        session.opened = True
        session.opened_at = self._monotonic()

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
            return data
        self._violation(session)
        return None

    def _violation(self, session: _Session) -> None:
        """Conta uma mensagem recusada (JSON ruim ou conteúdo inválido). Só uma aceita a zera."""
        session.violations += 1
        session.dropped += 1
        if session.violations >= MAX_VIOLATIONS:
            _log.warning("canal direto fechado: mensagens inválidas demais")
            self._halt(session)
            self._spawn(self._dispose(session, REASON_FAILED, notify=True))

    @staticmethod
    def _accepted(session: _Session) -> None:
        """Uma mensagem de conteúdo válido foi aceita: a sequência de recusas recomeça."""
        session.violations = 0
        session.used = True

    def _on_input(self, session: _Session, data: dict[str, Any], now: float) -> None:
        kind = data["k"]
        if not session.authenticated:
            # A primeira mensagem do canal de entrada TEM de ser o `auth` com o token da API.
            if kind == "auth" and self._token_ok(session, data.get("tok"), now):
                session.authenticated = True
                session.ready_at = now
                _log.info(
                    "canal direto aberto (sessão %s, negociação %.1f s)",
                    session.id[:8],
                    now - session.created,
                )
                self._note_cloud_marker(session, data)
                remaining = max(1, int(session.lifetime - (now - session.created)))
                # `caps`: as mensagens v2 que este agente aceita no canal. Um agente anterior não
                # manda o campo, e o app então não manda v2 pelo canal.
                self._send(
                    session,
                    INPUT_CHANNEL,
                    {"k": "ready", "life": remaining, "caps": sorted(CHANNEL_V2_TYPES)},
                )
            else:
                _log.warning("canal direto recusado: a primeira mensagem não trouxe o token válido")
                self._halt(session)
                self._spawn(self._dispose(session, REASON_FAILED, notify=True))
            return
        if kind != "cmd":
            self._violation(session)
            return
        self._on_command(session, data, now)

    @staticmethod
    def _note_cloud_marker(session: _Session, data: dict[str, Any]) -> None:
        """Guarda o `cs` (último pedido de entrada da nuvem que o app emitiu); só cresce."""
        marker = _as_int(data.get("cs"))
        epoch = data.get("ce")
        if (
            marker is None
            or not 0 <= marker <= MAX_CLOUD_SEQ
            or not isinstance(epoch, str)
            or _EPOCH_PATTERN.fullmatch(epoch) is None
        ):
            return  # sem época e número válidos juntos não há marcador: todo comando da nuvem fecha
        if session.cloud_epoch is None:
            session.cloud_epoch = epoch
        elif session.cloud_epoch != epoch:
            return  # uma página só por canal: outra época não mexe no marcador
        current = session.cloud_marker
        session.cloud_marker = marker if current is None else max(current, marker)

    def _remember_closed(self, session_id: str) -> None:
        """Lembra que a sessão fechou, por um pouco mais que a vida máxima de um canal."""
        now = self._monotonic()
        keep = self._settings.max_lifetime_seconds + TOMBSTONE_MARGIN_SECONDS
        for old in [key for key, at in self._closed_ids.items() if now - at > keep]:
            del self._closed_ids[old]
        self._closed_ids.pop(session_id, None)
        self._closed_ids[session_id] = now
        while len(self._closed_ids) > MAX_TOMBSTONES:
            del self._closed_ids[next(iter(self._closed_ids))]

    def _was_closed(self, session_id: str) -> bool:
        at = self._closed_ids.get(session_id)
        keep = self._settings.max_lifetime_seconds + TOMBSTONE_MARGIN_SECONDS
        return at is not None and self._monotonic() - at <= keep

    @staticmethod
    def _token_ok(session: _Session, token: object, now: float) -> bool:
        if not isinstance(token, str) or now > session.token_deadline:
            return False
        return hmac.compare_digest(token.encode("utf-8"), session.token.encode("utf-8"))

    def _on_command(  # noqa: PLR0911 - uma recusa por regra, cada uma com o seu código
        self, session: _Session, data: dict[str, Any], now: float
    ) -> None:
        command_id = data.get("i")
        message_type = data.get("t")
        body = data.get("b")
        # O `i` vira a operação no registro: só letras, números, `_` e `-`, nunca um caractere de
        # controle que falsifique uma linha do registro.
        if not isinstance(command_id, str) or _COMMAND_ID_PATTERN.fullmatch(command_id) is None:
            self._violation(session)
            return
        self._note_cloud_marker(session, data)

        def refuse(code: str, *, violation: bool = False) -> None:
            session.dropped += 1
            self._send(
                session, INPUT_CHANNEL, {"k": "ack", "i": command_id, "ok": False, "c": code}
            )
            if violation:
                self._violation(session)

        if (
            not isinstance(message_type, str)
            or message_type not in INPUT_TYPES
            or not isinstance(body, dict)
        ):
            refuse("not_allowed", violation=True)
            return
        release = _is_release(message_type, body)
        # Os tetos são conferidos já (a enxurrada é barrada antes de qualquer trabalho), mas só
        # são COBRADOS depois de o pedido passar na idade, na prontidão e no esquema: uma recusa
        # por `invalid_message`, `not_ready` ou `expired` não gasta vaga nem balde de ninguém.
        charges = self._rate_charges(session, message_type, body, release=release)
        if not all(rate.can(now, cost) for rate, cost in charges):
            refuse("rate_limited")
            return
        # Todo comando de entrada traz o instante do app (`ts`); sem ele não há como medir a idade.
        sent_ms = _as_millis(data.get("ts"))
        if sent_ms is None:
            refuse("invalid_message", violation=True)
            return
        age = self._age_of(session, sent_ms, release=release)
        if age is None:
            refuse("not_ready")  # a escala de relógio ainda não existe: só soltar passa
            return
        if age > MAX_COMMAND_AGE_SECONDS:
            refuse("expired")
            return
        # O movimento que antecedeu o comando entra antes dele, mesmo se o ponteiro atrasou.
        snapshot = data.get("p")
        if isinstance(snapshot, dict):
            self._apply_snapshot(session, snapshot, heartbeat=False)
        accepted = self._validate(message_type, body, age)
        if accepted is None:
            refuse("invalid_message", violation=True)
            return
        for rate, cost in charges:
            rate.charge(now, cost)
        self._accepted(session)

        def answered(result: CommandResult) -> None:
            ok = result.status.value == "ok"
            payload: dict[str, Any] = {"k": "ack", "i": command_id, "ok": ok}
            if not ok:
                payload["c"] = result.code or result.status.value
            self._send(session, INPUT_CHANNEL, payload)

        # O código do comando do app é a operação dele no registro (nunca o corpo).
        self._submit(replace(accepted.command, operation_id=command_id), answered)

    @staticmethod
    def _rate_charges(
        session: _Session, message_type: str, body: dict[str, Any], *, release: bool
    ) -> list[tuple[_Rate | _Bucket, int]]:
        """Os tetos que um pedido paga e quanto: soltar tem balde próprio; o resto paga mensagem,
        teclas e texto. Quem chama confere todos (`can`) e só cobra (`charge`) o que for aceito."""
        if release:
            return [(session.release_rate, 1)]
        text = body.get("text")
        charges: list[tuple[_Rate | _Bucket, int]] = [
            (session.input_rate, 1),
            (session.press_rate, _press_cost(message_type, body)),
        ]
        if isinstance(text, str):
            charges.append((session.text_rate, len(text)))
        return charges

    @staticmethod
    def _age_of(session: _Session, sent_ms: float, *, release: bool) -> float | None:
        """Idade do comando pelo relógio do app contra o monotônico daqui (como a nuvem faz).

        `None`: ainda não há escala de relógio (menos de dois sinais de vida que concordam), e
        o comando não é de soltar. Soltar sempre passa, com idade zero.
        """
        if release:
            return 0.0
        try:
            return session.clock.age(_iso(sent_ms))
        except OverflowError, OSError, ValueError:
            return None

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
        sent = _as_millis(data.get("t"))
        if sent is not None:
            with contextlib.suppress(OverflowError, OSError, ValueError):
                session.clock.observe(_iso(sent))
        rtt = _as_int(data.get("r"))
        if rtt is not None and 0 <= rtt < 60_000:  # noqa: PLR2004
            session.rtts.append(rtt)
            del session.rtts[:-MAX_RTT_SAMPLES]
        # `c`: a escala de relógio já existe (o app só passa a usar o canal depois disto).
        self._send(
            session,
            POINTER_CHANNEL,
            {"k": "pong", "n": data.get("n"), "c": session.clock.offset is not None},
        )

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
        self._accepted(session)
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
        accepted = self._validate(POINTER_TYPE, body, 0.0)
        if accepted is None:
            session.dropped += 1
            return
        self._submit(accepted.command, None)

    # ---- comandos -----------------------------------------------------------------------------

    def _validate(self, message_type: str, body: dict[str, Any], age: float) -> Accepted | None:
        """Passa pelo portão da nuvem; `None` se o contrato recusa (corpo fora do registro)."""
        envelope = {
            "v": 1,
            "id": str(uuid.uuid7()),
            "type": message_type,
            "source": "api",
            "target": f"agent:{self._agent_id}",
            "ts": self._stamp(age),
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

    def _stamp(self, age: float) -> str:
        """O `ts` de um comando com `age` segundos de idade, na escala de relógio da API.

        Os handlers conferem a idade como sempre (limite próprio de cada comando, `UP` isento): o
        `ts` carimbado aqui é "agora na escala da API" menos a idade medida neste canal. Sem
        escala da API ainda (sem batimentos), os handlers o valem como chegou, como na nuvem.
        """
        offset = self._api_clock.offset
        moment = (
            datetime.now(UTC)
            if offset is None
            else datetime.fromtimestamp(self._monotonic() - offset, UTC)
        )
        moment -= timedelta(seconds=max(0.0, age))
        return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # ---- fim ----------------------------------------------------------------------------------

    async def _watch(self, session: _Session) -> None:
        settings = self._settings
        while not session.closed:
            await asyncio.sleep(settings.tick_seconds)
            now = self._monotonic()
            if now - session.created > session.lifetime:
                await self._finish(session, REASON_LIFETIME)
                return
            if not session.authenticated:
                limit = min(
                    settings.connect_timeout_seconds, session.token_deadline - session.created
                )
                if now - session.created > limit:
                    if not session.opened and self._record is not None:
                        self._record("pc.direct_unreachable", "warn", _UNREACHABLE_HINT)
                    await self._finish(session, REASON_CONNECT_TIMEOUT)
                    return
            elif now - session.last_rx > settings.idle_seconds:
                await self._finish(session, REASON_IDLE)
                return

    def _halt(self, session: _Session) -> bool:
        """A parte síncrona de fechar: a sessão deixa de valer e o que o PC segurava é solto.

        Fechar o canal é como a conexão cair. Um canal que nunca autenticou não comandou nada: não
        há o que soltar (nem por que mexer no que veio pela nuvem). `False` se já estava fechada.
        """
        if session.closed:
            return False
        session.closed = True
        if self._current is session:
            self._current = None
            self._cancel_grace()
        watchdog = session.watchdog
        if watchdog is not None and watchdog is not asyncio.current_task():
            watchdog.cancel()
        if session.authenticated:
            try:
                self._direct_lost()
            except Exception:
                _log.exception("falha ao soltar o que o PC segurava")
        return True

    async def _finish(self, session: _Session, reason: str, *, notify: bool = True) -> None:
        if self._halt(session):
            await self._dispose(session, reason, notify=notify)

    async def _dispose(self, session: _Session, reason: str, *, notify: bool) -> None:
        """O resto de fechar: avisa o app do motivo, fecha o par, registra e avisa a API."""
        peer = session.peer
        if peer is not None:
            if session.authenticated and reason not in (REASON_FAILED, REASON_DISCONNECTED):
                # O app precisa saber o porquê (trocado, sessão encerrada, vida máxima...) para não
                # insistir quando não deve; o aviso leva um instante para sair antes de fechar.
                with contextlib.suppress(Exception):
                    peer.send(INPUT_CHANNEL, json.dumps({"k": "bye", "r": reason}))
                    await asyncio.sleep(BYE_FLUSH_SECONDS)
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
        """O ciclo do canal: uma linha no registro (INFO) e, se autenticou, uma no diagnóstico.

        Nenhuma das duas leva endereço, SDP, candidato nem token: só motivo, duração, RTT e perdas.
        """
        now = self._monotonic()
        median = statistics.median(session.rtts) if session.rtts else None
        if session.authenticated:
            _log.info(
                "canal direto fechado (sessão %s): motivo %s; aberto por %.0f s; RTT %s; "
                "movimentos perdidos %d; mensagens %d",
                session.id[:8],
                reason,
                now - (session.ready_at if session.ready_at is not None else session.created),
                _bucket(median, (10, 30, 100, 300)),
                session.lost_pointers,
                session.messages,
            )
        else:
            _log.info(
                "canal direto fechado antes de autenticar (sessão %s): motivo %s; %.1f s depois "
                "da oferta; os canais de dados %s",
                session.id[:8],
                reason,
                now - session.created,
                "abriram" if session.opened else "não abriram",
            )
        if self._record is None or not session.authenticated:
            return
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
    service: PcDirectService, transport: Sender, envelopes: EnvelopeFactory
) -> dict[str, Handler]:
    """Os `pc.rtc.*` que a API manda: a oferta (com a resposta pelo `pc.rtc.answer.v1`), o candidato
    tardio e o fechamento. Não passam pela conferência de idade nem pela faixa do PC."""

    async def offer(command: Command) -> CommandResult:
        body = command.body
        session_id = str(body["sessionId"])
        try:
            answer = await service.open(
                session_id,
                str(body["sdp"]),
                str(body["token"]),
                int(body["tokenTtlSeconds"]),
                int(body["maxLifetimeSeconds"]),
                device_id=command.device_id,
                device_name=command.device_name,
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
        reason = command.body.get("reason")
        await service.close(
            str(command.body["sessionId"]), reason if isinstance(reason, str) else REASON_REQUESTED
        )
        return CommandResult(command.id, ResultStatus.OK)

    return {OFFER_TYPE: offer, CANDIDATE_TYPE: candidate, CLOSE_TYPE: close}
