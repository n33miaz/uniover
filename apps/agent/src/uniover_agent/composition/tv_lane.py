"""Onde a TV vive: no laço principal ou num laço próprio (a faixa da TV, uma thread).

Com `tv_lane_thread` ligado, a sessão com a TV (Remote v2, ADB, Samsung), os handlers da TV, as
tarefas de fundo dela e a fila ordenada das teclas rodam todos no laço da faixa. Os objetos são
criados onde sempre foram (as travas e os eventos do asyncio só se prendem a um laço no primeiro
uso); daí em diante, todo uso passa por aqui:

- do laço principal para a TV: `post` (sem esperar), `call` (espera o resultado), `handler` (o
  comando da nuvem que não entra na fila das teclas) e `to_tv` (um aviso síncrono);
- da TV para o laço principal: `to_main` (o publicador do estado, a bandeja, o vigia do endereço,
  o diagnóstico) e `MainLoopTransport` (o envio de mensagens pela conexão com a API).

Sem a faixa, tudo aqui é chamada direta: o agente fica exatamente como antes.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Iterable
from functools import partial
from typing import Any, TypeVar

from uniover_agent.adapters.pc_input_thread import PcInputThread
from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import FreshKeyHandler, Handler
from uniover_agent.core.supervision import TaskHealth
from uniover_agent.ports import Transport

_log = logging.getLogger(__name__)

T = TypeVar("T")
Job = Callable[[], Coroutine[Any, Any, None]]

TV_LANE_THREAD_NAME = "uniover-tv-lane"


class MainLoopTransport:
    """O transporte visto da faixa da TV: o envio roda no laço principal, onde a conexão vive.

    Quem envia espera o resultado (inclusive o `TransportError`) sem prender o laço principal.
    Abrir, ler e fechar a conexão não são assunto da TV: só o laço principal faz isso.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, inner: Transport) -> None:
        self._loop = loop
        self._inner = inner

    @property
    def connected(self) -> bool:
        return self._inner.connected

    async def send(self, message: dict[str, Any]) -> None:
        if _running_loop() is self._loop:
            await self._inner.send(message)
            return
        future = asyncio.run_coroutine_threadsafe(self._inner.send(message), self._loop)
        await asyncio.wrap_future(future)

    async def connect(self) -> None:
        raise RuntimeError("a conexão com a API é aberta só pelo laço principal")

    def incoming(self) -> AsyncIterator[str | bytes]:
        raise RuntimeError("a conexão com a API é lida só pelo laço principal")

    async def close(self) -> None:
        raise RuntimeError("a conexão com a API é fechada só pelo laço principal")


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


class _HealthOnMain(TaskHealth):
    """A contagem de quedas das tarefas de fundo da TV, anotada no laço principal (quem a lê)."""

    def __init__(self, inner: TaskHealth, to_main: Callable[[Callable[[], None]], None]) -> None:
        self._inner = inner
        self._to_main = to_main

    def note_failure(self, name: str) -> None:
        self._to_main(partial(self._inner.note_failure, name))

    def recent_failures(self, within: float = 3600.0) -> dict[str, int]:
        return self._inner.recent_failures(within)


class TvLaneHop:
    """A ponte entre o laço principal e o laço da TV (que pode ser o mesmo)."""

    def __init__(
        self, main_loop: asyncio.AbstractEventLoop, host: PcInputThread | None = None
    ) -> None:
        self._main = main_loop
        self._host = host
        # As tarefas de fundo da TV no laço da faixa (só tocadas lá).
        self._jobs: list[asyncio.Task[None]] = []
        # Os comandos sem resposta entregues à faixa (só tocados lá).
        self._fired: set[asyncio.Task[CommandResult]] = set()

    @property
    def host(self) -> PcInputThread | None:
        return self._host

    def start(self) -> None:
        if self._host is not None:
            self._host.start()

    # ---- do laço principal para a TV ----

    def post(self, callback: Callable[[], None]) -> None:
        if self._host is None:
            callback()
        else:
            self._host.post(callback)

    async def call(self, factory: Callable[[], Awaitable[T]]) -> T:
        if self._host is None:
            return await factory()
        return await self._host.call(factory)

    def awaited(self, factory: Callable[[], Awaitable[T]]) -> Callable[[], Awaitable[T]]:
        """`factory` como corrotina do laço principal que roda no laço da TV."""
        if self._host is None:
            return factory
        return partial(self.call, factory)

    def to_tv(self, callback: Callable[..., None]) -> Callable[..., None]:
        """Um aviso síncrono para um objeto da TV (o vigia, o agendador): roda no laço dela."""
        if self._host is None:
            return callback
        host = self._host

        def hop(*args: Any) -> None:
            host.post(partial(callback, *args))

        return hop

    def handler(self, handler: Handler, *, silent: bool = False) -> Handler:
        """O handler da TV visto do laço principal: roda no laço da faixa.

        O comando sem resposta (`silent`: a presença) vai sem esperar, e o leitor segue. O handler
        de tecla continua marcado como tal (`FreshKeyHandler`)."""
        if self._host is None:
            return handler

        async def run(command: Command) -> CommandResult:
            if silent:
                self.post(partial(self._fire, handler, command))
                return CommandResult(command.id, ResultStatus.OK)
            return await self.call(partial(handler, command))

        return FreshKeyHandler(run) if isinstance(handler, FreshKeyHandler) else run

    def _fire(self, handler: Handler, command: Command) -> None:
        async def run() -> CommandResult:
            return await handler(command)

        task: asyncio.Task[CommandResult] = asyncio.get_running_loop().create_task(run())
        self._fired.add(task)
        task.add_done_callback(self._fired_done)

    def _fired_done(self, task: asyncio.Task[CommandResult]) -> None:
        self._fired.discard(task)
        if not task.cancelled() and task.exception() is not None:
            _log.warning("comando sem resposta da TV falhou (%s)", type(task.exception()).__name__)

    # ---- da TV para o laço principal ----

    def to_main(self, callback: Callable[..., None]) -> Callable[..., None]:
        """Um aviso que nasce na TV para quem vive no laço principal."""
        if self._host is None:
            return callback
        loop = self._main

        def hop(*args: Any) -> None:
            try:
                loop.call_soon_threadsafe(partial(callback, *args))
            except RuntimeError:  # o laço principal já fechou (encerrando)
                _log.debug("laço principal fechado: aviso da TV descartado")

        return hop

    def health(self, inner: TaskHealth) -> TaskHealth:
        return inner if self._host is None else _HealthOnMain(inner, self.to_main(_call))

    # ---- tarefas de fundo e encerramento ----

    def start_jobs(self, jobs: Iterable[Job]) -> None:
        """Sobe as tarefas de fundo da TV no laço da faixa (só com a faixa)."""
        chosen = tuple(jobs)

        def start() -> None:
            loop = asyncio.get_running_loop()
            self._jobs.extend(loop.create_task(job()) for job in chosen)

        self.post(start)

    async def stop_jobs(self) -> None:
        """Cancela as tarefas de fundo da TV, no laço delas, e espera que terminem."""
        if self._host is None or not self._host.alive:
            return

        async def stop() -> None:
            running = [*self._jobs, *self._fired]
            self._jobs.clear()
            for task in running:
                task.cancel()
            await asyncio.gather(*running, return_exceptions=True)

        await self._host.call(stop)

    async def stop(self) -> None:
        """Para a thread da faixa (depois de fechar a sessão e a fila). Sem thread órfã."""
        if self._host is not None:
            await asyncio.to_thread(self._host.stop)


def _call(callback: Callable[[], None]) -> None:
    callback()


def build_tv_lane(
    main_loop: asyncio.AbstractEventLoop,
    *,
    enabled: bool,
    exception_handler: Any = None,
) -> TvLaneHop:
    """A ponte da TV: com a faixa ligada, uma thread com laço próprio (ainda parada)."""
    if not enabled:
        return TvLaneHop(main_loop)
    return TvLaneHop(
        main_loop, PcInputThread(name=TV_LANE_THREAD_NAME, exception_handler=exception_handler)
    )


__all__ = [
    "TV_LANE_THREAD_NAME",
    "MainLoopTransport",
    "TvLaneHop",
    "build_tv_lane",
]
