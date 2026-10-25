"""Sessão da TV: conexão quente, hibernação por inatividade e reconexão no primeiro comando.

Este gerenciador é o **único** ponto que abre e fecha os canais da TV (um dono da conexão por TV:
dois clientes disputando o mesmo canal derrubam um ao outro). Não tem rede nem biblioteca de TV:
recebe os canais pelas portas e o relógio por injeção, então os testes andam o tempo à mão.

Dois estados diferentes, de propósito:

* `SessionState` é a máquina interna (dormindo, aquecendo, quente, reparando);
* `TvState` é o que se publica (`tv.state.v1`). Dormir **nunca** vira "TV desligada": o agente que
  hiberna não é a TV em standby, então `power` fica `unknown` sempre que o canal não está aberto.

Gentileza com a TV: uma TV com a pilha de rede engasgada piora com cada tentativa. Por isso

* antes de abrir o WebSocket, um teste de vida barato (conexão TCP curta) diz se alguém atende;
* quando a TV não atende o agente entra em "offline" (`connection = disconnected`) e só tenta de
  novo depois de uma espera que cresce (5, 10, 20, 40, 60 s, com variação aleatória) e zera quando
  a TV volta. Dentro da espera os pedidos falham na hora, sem tocar na rede;
* o registro conta a queda uma vez, a volta uma vez e um resumo de tempos em tempos;
* `POWER` com a TV fora da rede vira Wake-on-LAN (e nunca a tecla, que é um interruptor);
* o volume é lido ao abrir a sessão e logo depois de uma tecla de volume (nunca em sondagem).
"""

import asyncio
import logging
import random
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, NoReturn

from uniover_agent.core.domain import Connection, Power, TvState
from uniover_agent.ports import (
    Clock,
    TvChannel,
    TvChannelError,
    TvDriver,
    TvNotPaired,
    TvPortClosed,
    TvUnreachable,
)

_log = logging.getLogger(__name__)

TV_UNREACHABLE: Final = "tv_unreachable"
TV_NOT_PAIRED: Final = "tv_not_paired"

DEFAULT_HIBERNATE_SECONDS: Final = 300.0
# Espera entre as tentativas de abrir a sessão (1, 2 e 4 s) e depois desiste: sem laço infinito.
DEFAULT_BACKOFF: Final = (1.0, 2.0, 4.0)
# Espera entre as tentativas enquanto a TV está offline: cresce até o teto e zera quando ela volta.
DEFAULT_RETRY_STEPS: Final = (5.0, 10.0, 20.0, 40.0, 60.0)
DEFAULT_JITTER: Final = 0.2
# Quem está esperando a TV (uma tecla) pode furar a espera, mas não antes deste mínimo.
COMMAND_RETRY_FLOOR_SECONDS: Final = 5.0
OFFLINE_SUMMARY_SECONDS: Final = 600.0
# Depois do pacote de Wake-on-LAN, quanto esperar a TV atender e de quanto em quanto tempo olhar.
WAKE_ON_LAN_WAIT_SECONDS: Final = 25.0
WAKE_ON_LAN_POLL_SECONDS: Final = 2.5
# Depois do pacote mágico a TV está ligando: nesta janela `POWER` é recusado (ele a desligaria).
WAKE_ON_LAN_GUARD_SECONDS: Final = 60.0
# Antes de concluir que a TV está fora da rede, o teste de vida é repetido (rede lenta não conta).
WAKE_ON_LAN_LIVENESS_CHECKS: Final = 3
WAKE_ON_LAN_LIVENESS_PAUSE_SECONDS: Final = 1.0
# Tempo para o volume assentar na TV antes de lê-lo (teclas em sequência viram uma leitura só).
VOLUME_SETTLE_SECONDS: Final = 0.8
VOLUME_KEYS: Final = frozenset({"VOLUME_UP", "VOLUME_DOWN", "MUTE"})
# De quanto em quanto tempo o vigia de inatividade confere; a hibernação atrasa no máximo isso.
DEFAULT_POLL_SECONDS: Final = 5.0
_WARMUP_HISTORY: Final = 100
POWER_KEY: Final = "POWER"
# `POWER` é um interruptor: a primeira tecla desliga a TV e a segunda a liga de volta. Um segundo
# pedido logo depois do primeiro (toque duplo, o dono repetindo depois de um erro de tempo esgotado
# enquanto o agente ainda abria a sessão) quase sempre é repetição, e enviá-lo desfaria o
# desligamento. Passado esse tempo é um pedido novo e vale como qualquer outro.
POWER_REPEAT_SECONDS: Final = 10.0


class SessionState(StrEnum):
    HIBERNATING = "hibernating"
    WARMING = "warming"
    HOT = "hot"
    # Reservado ao vigia: ele entra e sai por `mark_repairing` e `clear_repairing`.
    REPAIRING = "repairing"


class TvSessionError(Exception):
    """A TV não pôde executar o comando; `code` vai para a API e `message` para o dono."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(slots=True)
class _Registered:
    channel: TvChannel
    required: bool


class TvSessionManager:
    def __init__(  # noqa: PLR0913 - cada argumento é um limite ou uma injeção, todos por nome
        self,
        clock: Clock,
        remote: TvDriver,
        *,
        hibernate_seconds: float = DEFAULT_HIBERNATE_SECONDS,
        backoff: tuple[float, ...] = DEFAULT_BACKOFF,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
        liveness: Callable[[], Awaitable[bool]] | None = None,
        retry_steps: tuple[float, ...] = DEFAULT_RETRY_STEPS,
        jitter: float = DEFAULT_JITTER,
        rng: Callable[[], float] = random.random,
        wake_on_lan: Callable[[], Awaitable[bool]] | None = None,
        volume_reader: Callable[[], Awaitable[int | None]] | None = None,
        offline_summary_seconds: float = OFFLINE_SUMMARY_SECONDS,
    ) -> None:
        self._clock = clock
        self._remote = remote
        self._hibernate_seconds = hibernate_seconds
        self._backoff = backoff
        self._poll_seconds = poll_seconds
        self._liveness = liveness
        self._retry_steps = retry_steps
        self._jitter = jitter
        self._rng = rng
        self._wake_on_lan = wake_on_lan
        self._volume_reader = volume_reader
        self._offline_summary_seconds = offline_summary_seconds
        # Offline: desde quando, quantas aberturas falharam em seguida e quando pode tentar de novo.
        self._offline_since: float | None = None
        self._failures = 0
        self._next_attempt_at = 0.0
        self._last_attempt_at: float | None = None
        self._last_summary: float | None = None
        self._volume_dirty = False
        self._volume_task: asyncio.Task[None] | None = None
        self._channels: list[_Registered] = [_Registered(remote, required=True)]
        self._state = SessionState.HIBERNATING
        self._connection: Connection = "hibernating"
        self._power: bool | None = None
        self._volume: int | None = None
        self._app: str | None = None
        self._last_activity = clock.monotonic()
        # Serializa abrir e fechar: dois comandos chegando juntos esperam o mesmo aquecimento.
        self._lock = asyncio.Lock()
        # Quando o último `POWER` chegou à TV (relógio monotônico) e a fila de quem o repete.
        self._power_sent_at: float | None = None
        # Até quando a TV está ligando por Wake-on-LAN (relógio monotônico) e a tarefa que a segue.
        self._wol_guard_until: float | None = None
        self._wol_task: asyncio.Task[None] | None = None
        # Mandei `POWER` com a TV ligada: a próxima queda de rede é ela desligada, não rede lenta.
        self._expect_off = False
        self._power_lock = asyncio.Lock()
        # A recuperação em segundo plano já reabriu a sessão e ninguém usou o controle desde então.
        self._reopened_unattended = False
        self._listeners: list[Callable[[TvState], None]] = []
        self._repair_callbacks: list[Callable[[], None]] = []
        self._last_emitted: TvState | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self.warmups: deque[float] = deque(maxlen=_WARMUP_HISTORY)
        remote.on_power(self._on_power)
        remote.on_app(self._on_app)
        remote.on_volume(self._on_volume)
        remote.on_available(self._on_available)

    # --- interface pública -------------------------------------------------------------------

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def offline(self) -> bool:
        """A TV não atendeu à última abertura e o agente está esperando para tentar de novo."""
        return self._offline_since is not None

    @property
    def last_warmup_seconds(self) -> float | None:
        """Duração do último aquecimento (para a medição de religação)."""
        return self.warmups[-1] if self.warmups else None

    def snapshot(self) -> TvState:
        """O que se publica agora. `power` só é afirmado com a sessão quente."""
        power: Power = "unknown"
        if self._connection == "hot" and self._power is not None:
            power = "on" if self._power else "off"
        return TvState(power, self._volume, self._app, self._connection)

    def subscribe(self, listener: Callable[[TvState], None]) -> None:
        """Avisa a cada mudança de estado publicável (chamada síncrona, no laço de eventos)."""
        self._listeners.append(listener)

    def on_needs_repair(self, callback: Callable[[], None]) -> None:
        """Sinal para o vigia: a TV recusou a conexão (o serviço do controle pode ter morrido).

        Dispara uma vez por aquecimento, já na primeira recusa; o vigia confere as portas. Uma TV
        que simplesmente não responde (standby, sem rede) não dispara o sinal.
        """
        self._repair_callbacks.append(callback)

    def add_channel(self, channel: TvChannel, *, required: bool = False) -> None:
        """Registra outro canal (ADB) para abrir e fechar junto com a sessão.

        Canal opcional que falha ao abrir só vai para o log: o controle por teclas segue.
        """
        self._channels.append(_Registered(channel, required))

    def touch(self) -> None:
        """Renova o relógio de hibernação."""
        self._last_activity = self._clock.monotonic()

    def mark_repairing(self) -> None:
        """O vigia assumiu: novos comandos devolvem `tv_unreachable` até `clear_repairing`."""
        if self._state is SessionState.REPAIRING:
            return
        self._state = SessionState.REPAIRING
        self._set_connection("disconnected")

    def clear_repairing(self) -> None:
        """O vigia terminou: volta a dormir; o próximo comando abre a sessão do zero."""
        if self._state is not SessionState.REPAIRING:
            return
        self._state = SessionState.HIBERNATING
        self._set_connection("hibernating")

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if key == POWER_KEY and direction == "SHORT":
            await self._send_power()
            return
        await self._run(lambda remote: remote.send_key(key, direction))
        if key in VOLUME_KEYS and direction in {"SHORT", "END_LONG"}:
            self._schedule_volume_read()

    async def _send_power(self) -> None:
        """`POWER` com um toque só: repetido em `POWER_REPEAT_SECONDS` do anterior, não é enviado.

        O tempo conta da chegada à TV (e não do pedido): o pedido pode ter esperado a sessão abrir
        por quase meio minuto. Se o envio falha, nada é marcado e o dono pode tentar de novo.
        Pressão longa (`START_LONG` e `END_LONG`) é um gesto só em dois envios: não passa por aqui.

        Com a TV fora da rede e a última notícia dela sendo "desligada" (ou nenhuma), o pedido vira
        Wake-on-LAN, e por `WAKE_ON_LAN_GUARD_SECONDS` a tecla é recusada: a TV está ligando e a
        tecla, que é um interruptor, a desligaria.
        """
        async with self._power_lock:
            now = self._clock.monotonic()
            sent_at = self._power_sent_at
            if sent_at is not None and now - sent_at < POWER_REPEAT_SECONDS:
                _log.info("POWER repetido logo após o anterior; não enviado para não religar a TV")
                return
            guard = self._wol_guard_until
            if guard is not None and now < guard:
                _log.info("a TV está ligando (Wake-on-LAN); POWER não enviado para não desligá-la")
                return
            if await self._should_wake_on_lan():
                await self._power_by_wake_on_lan()
            else:
                await self._run(lambda remote: remote.send_key(POWER_KEY, "SHORT"))
                self._expect_off = self._power is not False
            self._power_sent_at = self._clock.monotonic()

    def _may_be_off(self) -> bool:
        """A última notícia da TV não a dá por ligada (desligada, nenhuma, ou já está offline)."""
        return self._power is not True or self._expect_off or self._offline_since is not None

    async def _should_wake_on_lan(self) -> bool:
        """`POWER` com a TV fora da rede: não há canal para a tecla, só o pacote de despertar.

        Só quando a TV pode mesmo estar desligada, e depois de repetir o teste de vida: uma rede
        lenta não pode virar "fora da rede" (a TV ligada seria atendida com um pacote e a tecla de
        desligar nunca sairia).
        """
        if self._wake_on_lan is None or self._liveness is None or self._is_hot():
            return False
        if not self._may_be_off():
            return False
        for check in range(WAKE_ON_LAN_LIVENESS_CHECKS):
            if await self._liveness():
                return False
            if check < WAKE_ON_LAN_LIVENESS_CHECKS - 1:
                await self._clock.sleep(WAKE_ON_LAN_LIVENESS_PAUSE_SECONDS)
        return True

    async def _power_by_wake_on_lan(self) -> None:
        """Manda o pacote mágico e devolve na hora; a TV é acompanhada em segundo plano.

        Esperar a TV subir aqui seguraria a fila de comandos (a execução é em série) por até
        `WAKE_ON_LAN_WAIT_SECONDS`. A tecla `POWER` nunca é enviada depois: ela é um interruptor.
        """
        assert self._wake_on_lan is not None  # noqa: S101 - garantido por `_should_wake_on_lan`
        self.touch()
        if not await self._wake_on_lan():
            raise TvSessionError(TV_UNREACHABLE, "não consegui enviar o sinal de ligar à TV")
        _log.info("TV fora da rede: enviei o Wake-on-LAN em vez da tecla POWER")
        self._wol_guard_until = self._clock.monotonic() + WAKE_ON_LAN_GUARD_SECONDS
        self._expect_off = False
        self._wol_task = self._spawn(self._follow_wake_on_lan())

    async def _follow_wake_on_lan(self) -> None:
        """Acompanha a TV acordando: quando ela atende, abre a sessão (sem tecla nenhuma)."""
        assert self._liveness is not None  # noqa: S101 - garantido por `_should_wake_on_lan`
        waited = 0.0
        while waited < WAKE_ON_LAN_WAIT_SECONDS:
            await self._clock.sleep(WAKE_ON_LAN_POLL_SECONDS)
            waited += WAKE_ON_LAN_POLL_SECONDS
            if await self._liveness():
                self._reset_backoff()
                try:
                    await self._ensure_hot(interactive=False)
                except TvSessionError:
                    # A TV ligou; abrir a sessão fica para o próximo comando.
                    _log.debug("a TV ligou, mas a sessão ainda não abriu")
                return
        _log.warning(
            "enviei o Wake-on-LAN, mas a TV não respondeu; "
            "confira se ela aceita ligar pela rede (ligar com celular)"
        )

    async def launch_link(self, link: str) -> None:
        await self._run(lambda remote: remote.launch_link(link))

    async def send_text(self, text: str) -> None:
        """Define o texto do campo em foco na TV (substitui o conteúdo; não acrescenta)."""
        await self._run(lambda remote: remote.send_text(text))

    async def wake(self) -> None:
        """Pré-aquece: abre a sessão (se preciso) e renova o relógio.

        Nunca envia tecla (nem `POWER`, nem a que acorda a TV): o app pede isto de tempos em tempos
        enquanto a tela do controle está aberta, inclusive com a TV recém-desligada, e uma tecla
        aqui a ligaria de volta. Abrir a sessão só troca a configuração do protocolo com a TV.
        """
        self.touch()
        self._reopened_unattended = False
        await self._ensure_hot(interactive=False)

    async def hibernate_if_idle(self) -> bool:
        """Fecha os canais se passou o tempo sem comando; devolve se hibernou."""
        if self._state is not SessionState.HOT or not self._is_idle():
            return False
        async with self._lock:
            # Reconfere dentro do lock: um comando pode ter chegado enquanto se esperava.
            if self._state is not SessionState.HOT or not self._is_idle():
                return False
            await self._close_channels()
            self._state = SessionState.HIBERNATING
            self._set_connection("hibernating")
            _log.info("TV hibernada depois de %.0f s sem uso", self._hibernate_seconds)
            return True

    async def watch(self) -> None:
        """Laço de fundo: confere a inatividade até ser cancelado."""
        while True:
            await self._clock.sleep(self._poll_seconds)
            await self.hibernate_if_idle()

    async def aclose(self) -> None:
        """Encerramento do agente: cancela o que estiver em segundo plano e fecha os canais."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with self._lock:
            await self._close_channels()
            if self._state is not SessionState.REPAIRING:
                self._state = SessionState.HIBERNATING
                self._set_connection("hibernating")

    async def settle(self) -> None:
        """Espera as recuperações em segundo plano terminarem (testes e encerramento)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
            # Cede a vez: o `discard` de quem já terminou roda como callback do laço.
            await asyncio.sleep(0)

    # --- comandos ----------------------------------------------------------------------------

    async def _run(self, action: Callable[[TvDriver], Awaitable[None]]) -> None:
        self.touch()
        self._reopened_unattended = False
        await self._ensure_hot()
        try:
            await action(self._remote)
        except TvChannelError as exc:
            # O canal caiu entre a conferência e o envio: reabre uma vez e repete.
            _log.info("canal da TV caiu durante o comando (%s); reabrindo", exc)
            self._channel_lost()
            await self._ensure_hot()
            try:
                await action(self._remote)
            except TvChannelError as again:
                raise TvSessionError(TV_UNREACHABLE, str(again)) from None

    def _is_idle(self) -> bool:
        return self._clock.monotonic() - self._last_activity >= self._hibernate_seconds

    def _is_hot(self) -> bool:
        return self._state is SessionState.HOT and all(
            reg.channel.connected for reg in self._channels if reg.required
        )

    def _raise_if_repairing(self) -> None:
        if self._state is SessionState.REPAIRING:
            raise TvSessionError(TV_UNREACHABLE, "religando o controle da TV; tente em instantes")

    # --- abertura e fechamento ---------------------------------------------------------------

    async def _ensure_hot(self, *, interactive: bool = True) -> None:
        """Garante a sessão aberta.

        `interactive`: há alguém esperando (uma tecla, não o pré-aquecimento nem a recuperação em
        segundo plano), então a espera da TV offline pode ser furada, mas nunca antes de
        `COMMAND_RETRY_FLOOR_SECONDS` da última tentativa.
        """
        self._raise_if_repairing()
        if self._is_hot():
            return
        async with self._lock:
            self._raise_if_repairing()
            if self._is_hot():
                return
            self._raise_if_cooling_down(interactive=interactive)
            try:
                await self._warm()
            except BaseException:
                # Cancelamento ou erro inesperado no meio do aquecimento: não deixa `WARMING` preso.
                if self._state is SessionState.WARMING:
                    await asyncio.shield(self._close_channels())
                    self._state = SessionState.HIBERNATING
                    self._set_connection("disconnected")
                raise

    def _raise_if_cooling_down(self, *, interactive: bool) -> None:
        """TV offline e ainda dentro da espera: falha na hora, sem tocar na rede."""
        if self._offline_since is None:
            return
        now = self._clock.monotonic()
        if now >= self._next_attempt_at:
            return
        last = self._last_attempt_at
        if interactive and last is not None and now - last >= COMMAND_RETRY_FLOOR_SECONDS:
            return
        raise TvSessionError(TV_UNREACHABLE, "a TV está offline; tento de novo em instantes")

    async def _warm(self) -> None:
        """Abre os canais; chamada com o lock.

        Com a TV até agora bem, tenta algumas vezes com espera curta (1, 2 e 4 s): ela pode estar só
        acordando. Já offline, uma única tentativa por passo da espera crescente.
        """
        self._state = SessionState.WARMING
        started = self._clock.monotonic()
        quick = self._offline_since is None
        delays: list[float | None] = [*self._backoff, None] if quick else [None]
        signaled = False
        for attempt, delay in enumerate(delays, start=1):
            try:
                await self._attempt()
            except TvNotPaired as exc:
                await self._give_up(TV_NOT_PAIRED, str(exc))
            except TvUnreachable as exc:
                if not signaled and isinstance(exc, TvPortClosed):
                    # Porta recusada (serviço morto) já na primeira falha: o vigia ganha a janela
                    # das esperas para agir. Sem resposta nenhuma é a TV em standby: não é reparo.
                    signaled = True
                    self._signal_needs_repair()
                if delay is None:
                    await self._give_up(TV_UNREACHABLE, str(exc))
                _log.debug("TV não respondeu (tentativa %d): %s", attempt, exc)
                await self._clock.sleep(delay)
                self._raise_if_repairing()
            else:
                break
        if self._state is SessionState.REPAIRING:
            # O vigia assumiu durante a abertura: não se mantém uma sessão que ele vai refazer.
            await self._close_channels()
            self._raise_if_repairing()
        elapsed = self._clock.monotonic() - started
        self.warmups.append(elapsed)
        _log.info("sessão da TV aberta em %.2f s", elapsed)
        self._note_online()
        self._state = SessionState.HOT
        self.touch()
        self._set_connection("hot")
        # Uma leitura ao abrir a sessão: o contador já aparece antes de qualquer tecla de volume.
        self._schedule_volume_read()

    async def _attempt(self) -> None:
        """Uma tentativa: o teste de vida primeiro e o WebSocket só se alguém atende."""
        self._last_attempt_at = self._clock.monotonic()
        if self._liveness is not None and not await self._liveness():
            raise TvUnreachable("a TV não atende na rede")
        await self._open_channels()

    # --- TV offline: espera crescente e registro sem barulho -----------------------------------

    def _retry_delay(self) -> float:
        step = self._retry_steps[min(self._failures - 1, len(self._retry_steps) - 1)]
        return max(0.0, step * (1 + self._jitter * (2 * self._rng() - 1)))

    def _note_unreachable(self, reason: str) -> None:
        now = self._clock.monotonic()
        self._failures += 1
        self._next_attempt_at = now + self._retry_delay()
        if self._offline_since is None:
            self._offline_since = now
            self._last_summary = now
            _log.warning("a TV ficou offline (%s); tento de novo com espera crescente", reason)
        elif (
            self._last_summary is not None
            and now - self._last_summary >= self._offline_summary_seconds
        ):
            self._last_summary = now
            _log.info(
                "a TV segue offline há %.0f min (%d tentativas)",
                (now - self._offline_since) / 60,
                self._failures,
            )

    def _note_online(self) -> None:
        if self._offline_since is not None:
            _log.info(
                "a TV voltou depois de %.0f s offline (%d tentativas)",
                self._clock.monotonic() - self._offline_since,
                self._failures,
            )
        self._reset_backoff()

    def _reset_backoff(self) -> None:
        self._offline_since = None
        self._failures = 0
        self._next_attempt_at = 0.0
        self._last_summary = None

    async def _open_channels(self) -> None:
        opened: list[TvChannel] = []
        for reg in self._channels:
            try:
                await reg.channel.connect()
            except TvChannelError as exc:
                if reg.required:
                    for channel in opened:
                        await self._safe_disconnect(channel)
                    raise
                _log.warning("canal opcional da TV indisponível: %s", exc)
            else:
                opened.append(reg.channel)

    async def _give_up(self, code: str, message: str) -> NoReturn:
        await self._close_channels()
        if self._state is not SessionState.REPAIRING:
            self._state = SessionState.HIBERNATING
            self._set_connection("disconnected")
        self._raise_if_repairing()
        if code == TV_UNREACHABLE:
            self._note_unreachable(message)
        else:
            _log.warning("sessão da TV não abriu (%s): %s", code, message)
        hint = (
            "a TV ainda não foi pareada; rode `uniover-agent tv-pair`"
            if code == TV_NOT_PAIRED
            else "a TV não respondeu ao controle remoto"
        )
        raise TvSessionError(code, hint)

    async def _close_channels(self) -> None:
        for reg in self._channels:
            await self._safe_disconnect(reg.channel)

    @staticmethod
    async def _safe_disconnect(channel: TvChannel) -> None:
        try:
            await channel.disconnect()
        except TvChannelError as exc:
            _log.warning("falha ao fechar canal da TV: %s", exc)

    def _signal_needs_repair(self) -> None:
        for callback in self._repair_callbacks:
            try:
                callback()
            except Exception:
                _log.exception("falha no aviso de reparo da TV")

    # --- queda do canal e recuperação em segundo plano ----------------------------------------

    def _channel_lost(self) -> None:
        """O canal fechou sem o agente pedir (a TV derrubou o serviço, a rede piscou)."""
        if self._state is not SessionState.HOT:
            return
        self._state = SessionState.HIBERNATING
        self._set_connection("disconnected")
        self._spawn(self._recover())

    async def _recover(self) -> None:
        # Também é o caminho de uma TV recém-desligada (o standby derruba a sessão): reabre, com a
        # espera de sempre, e nunca envia tecla. Se a TV não responde, desiste.
        if self._state is not SessionState.HIBERNATING:
            return
        if self._is_idle():
            # Ninguém usa há tempo demais: dormir sai mais barato do que reabrir para nada.
            async with self._lock:
                if self._state is SessionState.HIBERNATING:
                    await self._close_channels()
                    self._set_connection("hibernating")
            return
        if self._reopened_unattended:
            # A TV aceitou a sessão que reabri sozinho e a derrubou de novo, sem ninguém ter usado o
            # controle: insistir viraria um laço de aberturas (uma TV em standby pode fazer isso).
            # A sessão fica fechada e o próximo comando ou aquecimento a reabre.
            _log.info("a TV derrubou de novo a sessão reaberta sozinha; espero o próximo uso")
            async with self._lock:
                if self._state is SessionState.HIBERNATING:
                    await self._close_channels()
            return
        try:
            await self._ensure_hot(interactive=False)
        except TvSessionError as exc:
            _log.info("TV não voltou sozinha: %s", exc.message)
        else:
            self._reopened_unattended = True

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.get_running_loop().create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # --- volume: lido ao abrir a sessão e depois de uma tecla de volume -----------------------

    def _schedule_volume_read(self) -> None:
        if self._volume_reader is None:
            return
        self._volume_dirty = True
        if self._volume_task is None or self._volume_task.done():
            self._volume_task = self._spawn(self._read_volume())

    async def _read_volume(self) -> None:
        """Uma leitura por rajada de teclas, depois de o volume assentar na TV."""
        assert self._volume_reader is not None  # noqa: S101 - garantido por `_schedule_volume_read`
        while self._volume_dirty:
            self._volume_dirty = False
            await self._clock.sleep(VOLUME_SETTLE_SECONDS)
            if not self._is_hot():
                return
            try:
                level = await self._volume_reader()
            except Exception as exc:
                _log.debug("volume da TV não lido (%s)", type(exc).__name__)
                return
            if level is not None:
                self._on_volume(level)

    # --- estado empurrado pela TV -------------------------------------------------------------

    def _on_power(self, is_on: bool) -> None:
        self._power = is_on
        if is_on:
            self._expect_off = False
        self._emit()

    def _on_app(self, app: str) -> None:
        self._app = app or None
        self._emit()

    def _on_volume(self, level: int) -> None:
        self._volume = max(0, min(100, level))
        self._emit()

    def _on_available(self, available: bool) -> None:
        if not available:
            self._channel_lost()

    def _set_connection(self, connection: Connection) -> None:
        self._connection = connection
        self._emit()

    def _emit(self) -> None:
        snapshot = self.snapshot()
        if snapshot == self._last_emitted:
            return
        self._last_emitted = snapshot
        for listener in self._listeners:
            try:
                listener(snapshot)
            except Exception:
                _log.exception("falha ao publicar o estado da TV")
