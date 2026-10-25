"""Laço de conexão: reconecta com backoff para sempre, mas para quando a credencial é recusada."""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.ports import (
    Clock,
    ConnectionReplaced,
    CredentialRejected,
    Transport,
    TransportError,
)

_log = logging.getLogger(__name__)

REVOKED_MESSAGE: Final = "token revogado ou inválido; rode `uniover-agent pair`"
APPLICATION_KEEPALIVE_SECONDS: Final = 25.0
# O `hello` volta de tempos em tempos: se a API do momento o recusou (ainda não conhecia um campo
# novo) ou foi trocada com o agente já conectado, ele passa a valer sem reiniciar o agente.
REHELLO_SECONDS: Final = 300.0


@dataclass(frozen=True, slots=True)
class BackoffPolicy:
    base: float = 1.0
    cap: float = 30.0
    # Quanto a conexão precisa durar para a espera voltar ao início.
    stable_after: float = 60.0
    # Espera depois de `replaced`: outra instância do mesmo agente assumiu; evita disputa.
    replaced_wait: float = 60.0
    # Fração de variação para mais e para menos (0,2 = de 80% a 120%).
    jitter: float = 0.2


class Backoff:
    """Espera exponencial com jitter limitado; sem número máximo de tentativas."""

    def __init__(self, policy: BackoffPolicy, random: Callable[[], float]) -> None:
        self._policy = policy
        self._random = random
        self._attempt = 0

    def next_delay(self) -> float:
        raw = min(self._policy.cap, self._policy.base * (2**self._attempt))
        self._attempt = min(self._attempt + 1, 32)
        factor = 1 + self._policy.jitter * (2 * self._random() - 1)
        # O teto vale também depois do jitter.
        return float(min(self._policy.cap, raw * factor))

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
        capabilities: Sequence[str],
        policy: BackoffPolicy | None = None,
        on_connected: Callable[[], Awaitable[None]] | None = None,
        on_disconnected: Callable[[], None] | None = None,
        keepalive_interval: float = APPLICATION_KEEPALIVE_SECONDS,
        rehello_interval: float = REHELLO_SECONDS,
        os_description: str | None = None,
        tv: tuple[str, str] | None = None,
        update_status: Callable[[], dict[str, Any] | None] | None = None,
    ) -> None:
        self._transport = transport
        self._process = process_message
        self._envelopes = envelopes
        self._clock = clock
        self._agent_version = agent_version
        self._capabilities = tuple(capabilities)
        self._policy = policy or BackoffPolicy()
        self._backoff = Backoff(self._policy, random)
        # Roda a cada conexão, logo depois do `hello` (ex.: informar à API o estado atual da TV).
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        self._keepalive_interval = keepalive_interval
        self._rehello_interval = rehello_interval
        # Opcionais do `hello` (sistema do PC; tipo e endereço da TV): só aparecem na tela do dono.
        self._os_description = os_description
        self._tv = tv
        # Lido a cada `hello`: o estado da auto-atualização muda com o tempo.
        self._update_status = update_status

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
                self._capabilities,
                os_description=self._os_description,
                tv=self._tv,
                update=update,
            )
        except ValueError:
            if update is None:
                raise
            # Sem o estado da atualização o agente ainda conecta, nunca fica fora do ar por ele.
            _log.warning("estado da atualização fora do contrato; o hello segue sem ele")
            return self._envelopes.hello(
                self._agent_version,
                self._capabilities,
                os_description=self._os_description,
                tv=self._tv,
            )

    async def run(self) -> None:
        """Roda até ser cancelado; devolve (sem erro) só quando a credencial é recusada.

        Quem chamar deve tratar a devolução como "parar": o token continua guardado até o usuário
        decidir (não se apaga sozinho).
        """
        while True:
            try:
                await self._session()
            except CredentialRejected:
                _log.error(REVOKED_MESSAGE)
                return
            except ConnectionReplaced:
                wait = self._policy.replaced_wait
                _log.warning(
                    "outra instância deste agente assumiu a conexão; nova tentativa em %.0f s", wait
                )
                await self._clock.sleep(wait)
                continue
            except TransportError as exc:
                _log.warning("conexão perdida (%s)", exc)
            else:
                _log.info("conexão encerrada pelo servidor")
            delay = self._backoff.next_delay()
            _log.info("reconectando em %.1f s", delay)
            await self._clock.sleep(delay)

    async def _session(self) -> None:
        started: float | None = None
        keepalive: asyncio.Task[None] | None = None
        try:
            await self._transport.connect()
            started = self._clock.monotonic()
            _log.info("conectado")
            await self._transport.send(self._hello())
            if self._on_connected is not None:
                await self._on_connected()
            keepalive = asyncio.create_task(self._send_keepalives())
            async for raw in self._transport.incoming():
                await self._process(raw)
        finally:
            if keepalive is not None:
                keepalive.cancel()
                await asyncio.gather(keepalive, return_exceptions=True)
            if (
                started is not None
                and self._clock.monotonic() - started >= self._policy.stable_after
            ):
                self._backoff.reset()
            await self._transport.close()
            if self._on_disconnected is not None:
                self._on_disconnected()

    async def _send_keepalives(self) -> None:
        last_hello = self._clock.monotonic()
        while True:
            await asyncio.sleep(self._keepalive_interval)
            await self._transport.send(self._envelopes.keepalive())
            if self._clock.monotonic() - last_hello >= self._rehello_interval:
                last_hello = self._clock.monotonic()
                await self._transport.send(self._hello())
