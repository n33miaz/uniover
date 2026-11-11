"""O laço de eventos próprio da entrada do PC: uma thread dedicada, com prioridade acima do normal.

Mouse, teclado, mídia, zoom, volume e o canal direto (WebRTC) vivem aqui, longe do laço principal
(TV, rede, diagnóstico, atualização). Medido em produção: com o PC sob pouca memória o laço
principal ficou parado mais de 1 s em quase todos os minutos e até 250 s de uma vez, e o mouse
parou junto, porque tudo dividia um laço só. Agora o laço principal só valida a mensagem e a
entrega aqui com `post` (fila sem bloqueio, na ordem de chegada); o que sai (resultados, avisos)
volta pelo `MainLoopSender`, que também nunca prende este laço.

Duas coisas que o isolamento NÃO resolve, e que valem dizer: as duas threads dividem o mesmo
processo e o mesmo GIL (uma chamada de C que segura o GIL por muito tempo para as duas), e o
Windows ainda decide quem recebe CPU. Por isso a prioridade da thread e o conjunto de trabalho
mínimo do processo (`windows_scheduling`) vêm junto.

A thread é supervisionada: um erro numa tarefa ou num callback vai para o registro e o laço segue;
se o próprio laço sair sem ter sido pedido, ele é recriado. Parar é `stop()`.
"""

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from typing import Any, Final, TypeVar

from uniover_agent.ports import TransportError

_log = logging.getLogger(__name__)

T = TypeVar("T")

# Espera da partida e do encerramento da thread: nenhuma das duas pode prender o agente.
START_TIMEOUT_SECONDS: Final = 5.0
STOP_TIMEOUT_SECONDS: Final = 5.0
# Pausa antes de recomeçar uma tarefa de fundo que falhou (nunca num laço quente).
RESTART_DELAY_SECONDS: Final = 1.0
# Prazo para o executor padrão do laço (a carga do `aiortc`, por exemplo) terminar ao encerrar.
SHUTDOWN_EXECUTOR_SECONDS: Final = 2.0

ExceptionHandler = Callable[[asyncio.AbstractEventLoop, dict[str, Any]], None]
Background = Callable[[], Coroutine[Any, Any, None]]


class PcInputThread:
    """Uma thread com um laço asyncio só dela. Implementa `LaneHost`."""

    def __init__(
        self,
        *,
        name: str = "uniover-pc-input",
        prioritize: Callable[[], bool] | None = None,
        exception_handler: ExceptionHandler | None = None,
        background: Iterable[Background] = (),
    ) -> None:
        self._name = name
        self._prioritize = prioritize
        self._exception_handler = exception_handler
        self._background = tuple(background)
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = threading.Event()
        self._stopping = False
        self.prioritized = False

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        """O laço da thread (para quem monta o resto do que vive nele)."""
        return self._loop

    @property
    def alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive() and not self._stopping

    def start(self) -> None:
        """Sobe a thread e espera o laço ficar pronto (milissegundos)."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()
        if not self._ready.wait(START_TIMEOUT_SECONDS):
            raise RuntimeError("o laço da entrada do PC não subiu a tempo")

    def post(self, callback: Callable[[], None]) -> None:
        """Agenda `callback` no laço da thread, na ordem das chamadas. Nunca bloqueia."""
        loop = self._loop
        if loop is None or self._stopping:
            _log.debug("entrada do PC parada: mensagem descartada")
            return
        try:
            loop.call_soon_threadsafe(callback)
        except RuntimeError:  # o laço já fechou (encerrando)
            _log.debug("entrada do PC fechada: mensagem descartada")

    async def call(
        self, factory: Callable[[], Awaitable[T]], wait_seconds: float | None = None
    ) -> T:
        """Roda `factory()` no laço da thread e devolve o resultado (quem chama espera, não ela)."""
        loop = self._loop
        if loop is None or self._stopping:
            raise RuntimeError("a entrada do PC não está rodando")

        async def run() -> T:
            return await factory()

        future = asyncio.wrap_future(asyncio.run_coroutine_threadsafe(run(), loop))
        if wait_seconds is None:
            return await future
        async with asyncio.timeout(wait_seconds):
            return await future

    def stop(self) -> None:
        """Pede o fim do laço e espera a thread sair (bloqueia: chame fora do laço principal)."""
        thread, loop = self._thread, self._loop
        self._stopping = True
        if loop is not None:
            try:
                loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                pass
        if thread is not None and thread is not threading.current_thread():
            thread.join(STOP_TIMEOUT_SECONDS)
            if thread.is_alive():
                _log.warning("a thread da entrada do PC não encerrou a tempo")

    # ---- dentro da thread ---------------------------------------------------------------------

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            if self._prioritize is not None:
                self.prioritized = self._prioritize()
            if self._exception_handler is not None:
                loop.set_exception_handler(self._exception_handler)
            tasks = [loop.create_task(self._supervised(job)) for job in self._background]
            self._ready.set()
            while not self._stopping:
                try:
                    loop.run_forever()
                except BaseException:
                    # Um callback que levanta algo grave não derruba a entrada do PC: registra e
                    # o laço volta (tudo o que estava agendado continua agendado).
                    _log.exception("o laço da entrada do PC saiu com erro; recomeçando")
            for task in tasks:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.run_until_complete(
                asyncio.wait_for(loop.shutdown_default_executor(), SHUTDOWN_EXECUTOR_SECONDS)
            )
        finally:
            self._ready.set()
            loop.close()

    @staticmethod
    async def _supervised(job: Background) -> None:
        """Uma tarefa de fundo que recomeça depois de um erro (o medidor de atraso, por exemplo)."""
        while True:
            try:
                await job()
                return
            except asyncio.CancelledError:
                raise
            except TransportError, OSError:
                _log.debug("tarefa de fundo da entrada do PC falhou", exc_info=True)
            except Exception:
                _log.exception("tarefa de fundo da entrada do PC falhou")
            await asyncio.sleep(RESTART_DELAY_SECONDS)


class MainLoopSender:
    """Um `Sender` para quem vive no laço da entrada: leva o envio ao laço do transporte.

    O envio roda no laço principal (onde o WebSocket vive) e quem chamou só espera o resultado, que
    pode ser o `TransportError` dele. Se o laço principal estiver parado, quem espera é a tarefa
    de envio da faixa (limitada, ver `MAX_PENDING_RESULTS`), nunca a execução dos comandos.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, inner: Any) -> None:
        self._loop = loop
        self._inner = inner

    async def send(self, message: dict[str, Any]) -> None:
        future = asyncio.run_coroutine_threadsafe(self._inner.send(message), self._loop)
        await asyncio.wrap_future(future)

    def fire(self, message: dict[str, Any]) -> None:
        """Envia sem esperar (avisos que ninguém aguarda)."""
        future = asyncio.run_coroutine_threadsafe(self._inner.send(message), self._loop)
        future.add_done_callback(_log_send_failure)


def _log_send_failure(future: Any) -> None:
    if future.cancelled():
        return
    exc = future.exception()
    if isinstance(exc, TransportError):
        _log.debug("aviso não enviado (%s)", exc)
    elif exc is not None:
        _log.warning("aviso não enviado (%s)", type(exc).__name__)


class MainLoopCaller:
    """Leva chamadas simples da thread da entrada para o laço principal (sem esperar)."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def __call__(self, callback: Callable[..., None], *args: Any) -> None:
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:  # o laço principal já fechou (encerrando)
            _log.debug("laço principal fechado: aviso descartado")
