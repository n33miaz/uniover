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
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError, Transport, TransportError, TvAdb

_log = logging.getLogger(__name__)

SEND_FAILED = "send_failed"


class Wakeable(Protocol):
    """O que o ADB pede à sessão da TV: abrir e manter quente (o `TvSessionManager`)."""

    async def wake(self) -> None: ...


class TvApps:
    """Lista de apps e abertura por pacote, com a última lista guardada."""

    def __init__(
        self, tv: Wakeable, adb: TvAdb, transport: Transport, envelopes: EnvelopeFactory
    ) -> None:
        self._tv = tv
        self._adb = adb
        self._transport = transport
        self._envelopes = envelopes
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
        """Envia `tv.apps.v1`. Falha de envio sobe como `TransportError`."""
        await self._transport.send(
            self._envelopes.tv_apps([(app.package, app.label) for app in apps], correlation_id)
        )

    async def launch_package(self, package: str) -> None:
        """Abre o app. `ValueError` se o nome do pacote não tem o formato do Android."""
        await self._warm()
        try:
            await self._adb.launch_package(package)
        except AdbError as exc:
            raise TvSessionError(exc.code, exc.message) from None


def tv_apps_refresh_handler(apps: TvApps) -> Handler:
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

    def __init__(self, apps: TvApps, is_hot: Callable[[], bool]) -> None:
        self._apps = apps
        self._is_hot = is_hot
        self._announced = False
        self._trigger = asyncio.Event()

    async def after_hello(self) -> None:
        """Nova conexão com a API: a lista precisa chegar de novo. Só marca, não espera nada."""
        self._announced = False
        self._trigger.set()

    def on_state(self, state: TvState) -> None:
        if state.connection == "hot":
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

    async def _announce_once(self) -> None:
        if self._announced:
            return
        try:
            if self._apps.cache is not None:
                apps = self._apps.cache
            elif self._is_hot():
                apps = await self._apps.refresh()
            else:
                return
            await self._apps.publish(apps)
        except TvSessionError as exc:
            _log.warning("lista de apps da TV não obtida (%s)", exc.code)
        except TransportError as exc:
            _log.debug("lista de apps não enviada (%s)", exc)
        else:
            self._announced = True
