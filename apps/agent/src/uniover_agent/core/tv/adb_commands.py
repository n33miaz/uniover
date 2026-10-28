"""Comandos da TV que dependem do canal ADB: lista de apps e abertura por pacote.

A lista é publicada em `tv.apps.v1` (agente para API) quando a API pede (`tv.apps.refresh.v1`) e
uma vez por conexão com a API, assim que o canal ADB está pronto. A última lista fica em memória:
numa reconexão ela é reenviada sem tocar na TV (que tem pouca memória livre).
"""

import asyncio
import logging
from collections.abc import Callable
from typing import Protocol

from uniover_agent.core.domain import Command, CommandResult, ResultStatus, TvState
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.apps import AppEntry, describe_apps
from uniover_agent.core.tv.handlers import failed_result
from uniover_agent.core.tv.icons import IconRequests
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError, Transport, TransportError, TvAdb

_log = logging.getLogger(__name__)

SEND_FAILED = "send_failed"
# A lista de apps é consultada à TV no pareamento, quando o app pede e, no máximo, uma vez por dia.
LIST_MAX_AGE_SECONDS = 86400.0
LIST_RETRY_SECONDS = 3600.0
# Sem lista nenhuma ainda: tenta de novo em 2, 5 e (no teto) 15 minutos.
FIRST_LIST_RETRY_SECONDS = (120.0, 300.0, 900.0)


class Wakeable(Protocol):
    """O que o ADB pede à sessão da TV: abrir e manter quente (o `TvSessionManager`)."""

    async def wake(self) -> None: ...


class AppsProvider(Protocol):
    """Lista de apps de qualquer driver de TV e a última resposta reaproveitável."""

    cache: list[AppEntry] | None

    async def refresh(self) -> list[AppEntry]: ...

    async def publish(self, apps: list[AppEntry], correlation_id: str | None = None) -> None: ...


class TvApps:
    """Lista de apps e abertura por pacote, com a última lista guardada."""

    def __init__(
        self,
        tv: Wakeable,
        adb: TvAdb,
        transport: Transport,
        envelopes: EnvelopeFactory,
        icons: IconRequests | None = None,
    ) -> None:
        self._tv = tv
        self._adb = adb
        self._transport = transport
        self._envelopes = envelopes
        # Sem `aapt2` neste PC não há publicador de ícones e a lista segue como sempre foi.
        self._icons = icons
        self.cache: list[AppEntry] | None = None

    async def _warm(self) -> None:
        """Mantém a sessão quente (e o ADB aberto com ela). Se o controle remoto não responde, o
        ADB segue sozinho: o serviço do remoto pode estar morto sem o ADB ter nada."""
        try:
            await self._tv.wake()
        except TvSessionError as exc:
            _log.info("controle remoto indisponível (%s); seguindo só pelo ADB", exc.code)

    async def refresh(self) -> list[AppEntry]:
        """Pergunta à TV os apps, guarda e devolve (filtrados e com nome)."""
        await self._warm()
        try:
            launchables = await self._adb.list_apps()
        except AdbError as exc:
            raise TvSessionError(exc.code, exc.message) from None
        apps = describe_apps(launchables)
        self.cache = apps
        return apps

    async def publish(self, apps: list[AppEntry], correlation_id: str | None = None) -> None:
        """Envia `tv.apps.v1` (sem ícones, sempre primeiro) e só então pede os ícones ao fundo.

        Falha de envio sobe como `TransportError`. Pedir os ícones só marca trabalho: a resposta ao
        comando e as teclas seguintes nunca esperam um APK.
        """
        await self._transport.send(
            self._envelopes.tv_apps([(app.package, app.label) for app in apps], correlation_id)
        )
        if self._icons is not None:
            # Reenvio numa reconexão (sem pedido do app) reaproveita as versões já lidas da TV.
            self._icons.request(apps, refresh_versions=correlation_id is not None)

    async def launch_package(self, package: str) -> None:
        """Abre o app. `ValueError` se o nome do pacote não tem o formato do Android."""
        await self._warm()
        try:
            await self._adb.launch_package(package)
        except AdbError as exc:
            raise TvSessionError(exc.code, exc.message) from None


def tv_apps_refresh_handler(apps: AppsProvider) -> Handler:
    """`tv.apps.refresh.v1`: lista os apps pelo ADB, envia `tv.apps.v1` e responde ao pedido."""

    async def handle(command: Command) -> CommandResult:
        try:
            entries = await apps.refresh()
            await apps.publish(entries, command.id)
        except TvSessionError as exc:
            return failed_result(command, exc)
        except TransportError:
            return CommandResult(
                command.id, ResultStatus.FAILED, "não consegui enviar a lista à API", SEND_FAILED
            )
        return CommandResult(command.id, ResultStatus.OK)

    return handle


class AppsAnnouncer:
    """Publica a lista de apps uma vez por conexão com a API, quando o ADB já pode respondê-la.

    Roda fora do laço de mensagens: um erro do ADB aqui nunca derruba a conexão com a API. Havendo
    lista guardada, ela é reenviada na hora; senão espera a sessão ficar quente (`on_state`).
    """

    def __init__(  # noqa: PLR0913
        self,
        apps: AppsProvider,
        is_hot: Callable[[], bool],
        *,
        monotonic: Callable[[], float] | None = None,
        max_age_seconds: float = LIST_MAX_AGE_SECONDS,
        retry_seconds: float = LIST_RETRY_SECONDS,
        is_paused: Callable[[], bool] = lambda: False,
    ) -> None:
        self._apps = apps
        self._is_hot = is_hot
        # Lista em cache vale um dia; uma consulta que falhou só é repetida depois de uma hora.
        self._monotonic = monotonic
        self._max_age = max_age_seconds
        self._retry = retry_seconds
        self._is_paused = is_paused
        self._seen_cache: list[AppEntry] | None = None
        self._seen_at = 0.0
        self._retry_at = 0.0
        self._failures = 0
        self._announced = False
        self._deferred = False
        self._trigger = asyncio.Event()

    async def after_hello(self) -> None:
        """Nova conexão com a API: a lista precisa chegar de novo. Só marca, não espera nada."""
        self._announced = False
        self._trigger.set()

    def on_state(self, state: TvState) -> None:
        if state.connection == "hot":
            self._trigger.set()

    def resume(self) -> None:
        """O foco terminou: uma publicação adiada durante a trégua é refeita agora."""
        if self._deferred:
            self._deferred = False
            self._trigger.set()

    async def run(self) -> None:
        while True:
            await self._trigger.wait()
            self._trigger.clear()
            try:
                await self._announce_once()
            except Exception:
                # Nada aqui pode derrubar o agente; o próximo evento tenta de novo.
                _log.exception("falha ao publicar a lista de apps da TV")

    def _schedule_retry(self, *, has_cache: bool) -> None:
        """Depois de uma consulta que falhou: uma hora de espera se já há lista (só a renovação
        diária falhou); sem lista nenhuma, o app ficaria vazio, então tenta de novo em poucos
        minutos, com espera crescente."""
        self._failures += 1
        if self._monotonic is None:
            self._retry_at = 0.0  # sem relógio não há espera entre tentativas
        elif has_cache:
            self._retry_at = self._now() + self._retry
        else:
            steps = FIRST_LIST_RETRY_SECONDS
            self._retry_at = self._now() + steps[min(self._failures - 1, len(steps) - 1)]

    def _now(self) -> float:
        return self._monotonic() if self._monotonic is not None else 0.0

    def _cache_is_stale(self) -> bool:
        """A lista guardada tem mais de um dia (contado de quando este vigia a viu)."""
        cache = self._apps.cache
        if cache is not self._seen_cache:
            self._seen_cache, self._seen_at = cache, self._now()
            return False
        return self._monotonic is not None and self._now() - self._seen_at >= self._max_age

    async def _announce_once(self) -> None:
        if self._is_paused():
            self._deferred = True
            return
        if self._announced:
            return
        try:
            cache = self._apps.cache
            stale = cache is not None and self._cache_is_stale()
            if cache is not None and not (
                stale and self._is_hot() and self._now() >= self._retry_at
            ):
                apps = cache
            elif self._is_hot() and self._now() >= self._retry_at:
                apps = await self._apps.refresh()
                self._seen_cache, self._seen_at = self._apps.cache, self._now()
            elif cache is not None:
                apps = cache
            else:
                return
            await self._apps.publish(apps)
        except TvSessionError as exc:
            self._schedule_retry(has_cache=self._apps.cache is not None)
            _log.warning("lista de apps da TV não obtida (%s)", exc.code)
        except TransportError as exc:
            _log.debug("lista de apps não enviada (%s)", exc)
        else:
            self._announced = True
            self._failures = 0
