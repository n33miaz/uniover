"""Pareamento da Android TV pedido pelo app: dois passos, sempre por toque do dono.

Quando a TV deixa de aceitar o certificado do UniOver, o agente só avisa (`not_paired`) e para de
insistir. O app oferece "Parear de novo"; o toque manda `tv.pair.v1` sem código (a TV mostra na tela
um código de 6 caracteres) e, depois que a pessoa o digita, `tv.pair.v1` com `code` (o agente
conclui). Nada aqui roda sozinho: sem o primeiro toque o agente nunca fala com a porta de
pareamento da TV, e o código nunca vai para o registro, para a auditoria nem para uma mensagem.

O pareamento em si é o `pair_tv` do adaptador; este serviço só o deixa esperar o código vindo do app
em vez de uma janela do Windows.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Final

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import TvPairingFailed

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1` só depois de a API listar `tv.pair.v1` em `features`.
PAIR_CAPABILITY: Final = "tv.pair.v1"

PAIR_NOT_STARTED: Final = "pair_not_started"
PAIR_FAILED: Final = "pair_failed"
PAIR_TIMEOUT: Final = "pair_timeout"
PAIR_BUSY: Final = "pair_busy"
TV_UNREACHABLE_CODE: Final = "tv_unreachable"
# Quanto o código fica valendo na tela da TV (a TV o cancela sozinha pouco depois).
DEFAULT_CODE_SECONDS: Final = 180.0
# Quanto cada passo espera pela TV antes de responder ao app, e quanto um pedido espera a vez do
# anterior. A API espera 30 s por resposta: o pior caso aqui (a vez + o passo) é 20 s, com folga.
DEFAULT_STEP_SECONDS: Final = 15.0
DEFAULT_LOCK_SECONDS: Final = 5.0

# Roda o pareamento; `ask_code` é chamado quando a TV já mostra o código e devolve o digitado.
PairRun = Callable[[Callable[[], Awaitable[str]]], Awaitable[None]]


class TvPairing:
    def __init__(
        self,
        run: PairRun,
        on_paired: Callable[[], Awaitable[None]],
        *,
        code_seconds: float = DEFAULT_CODE_SECONDS,
        step_seconds: float = DEFAULT_STEP_SECONDS,
        lock_seconds: float = DEFAULT_LOCK_SECONDS,
    ) -> None:
        self._run = run
        self._on_paired = on_paired
        self._code_seconds = code_seconds
        self._step_seconds = step_seconds
        self._lock_seconds = lock_seconds
        self._lock = asyncio.Lock()
        # A reabertura da sessão depois de pareada roda à parte: o app já recebeu a resposta.
        self._reopen: asyncio.Task[None] | None = None
        self._task: asyncio.Task[None] | None = None
        self._code: asyncio.Future[str] | None = None
        self._failure: tuple[str, str] | None = None

    def handler(self) -> Handler:
        """`tv.pair.v1`: sem `code` pede o código na TV; com `code` conclui; `cancel` desiste."""

        async def handle(command: Command) -> CommandResult:
            cancel = command.body.get("cancel") is True
            code = command.body.get("code")
            if not cancel and code is not None and not isinstance(code, str):
                return CommandResult(command.id, ResultStatus.REJECTED, "código inválido")
            try:
                await asyncio.wait_for(self._lock.acquire(), self._lock_seconds)
            except TimeoutError:
                return CommandResult(
                    command.id,
                    ResultStatus.REJECTED,
                    "outro pedido de pareamento em curso",
                    PAIR_BUSY,
                )
            try:
                if cancel:
                    return await self._abort(command)
                if code is None:
                    return await self._start(command)
                return await self._finish(command, code)
            finally:
                self._lock.release()

        return handle

    async def settled(self) -> None:
        """Espera a reabertura da sessão depois de um pareamento (usada ao fechar e nos testes)."""
        task = self._reopen
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def aclose(self) -> None:
        await self._cancel()
        task, self._reopen = self._reopen, None
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def _abort(self, command: Command) -> CommandResult:
        """O app fechou a folha: o código deixa de ser esperado (e some da tela da TV)."""
        await self._cancel()
        self._failure = None
        return CommandResult(command.id, ResultStatus.OK)

    async def _cancel(self) -> None:
        task, self._task = self._task, None
        self._code = None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _start(self, command: Command) -> CommandResult:
        # Um pedido novo vale mais que o código anterior (a TV o descartou ou a pessoa pediu outro).
        await self._cancel()
        loop = asyncio.get_running_loop()
        shown = asyncio.Event()
        code: asyncio.Future[str] = loop.create_future()
        self._code, self._failure = code, None

        async def ask_code() -> str:
            shown.set()
            return await asyncio.wait_for(code, self._code_seconds)

        task = loop.create_task(self._pair(ask_code))
        self._task = task
        waiter = loop.create_task(shown.wait())
        try:
            await asyncio.wait(
                {waiter, task}, timeout=self._step_seconds, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            waiter.cancel()
        if shown.is_set():
            return CommandResult(command.id, ResultStatus.OK)
        failure = self._failure or (TV_UNREACHABLE_CODE, "a TV não respondeu ao pareamento")
        await self._cancel()
        return CommandResult(command.id, ResultStatus.FAILED, failure[1], failure[0])

    async def _pair(self, ask_code: Callable[[], Awaitable[str]]) -> None:
        try:
            await self._run(ask_code)
        except TvPairingFailed as exc:
            self._failure = (exc.reason, str(exc))
        except TimeoutError:
            self._failure = (PAIR_TIMEOUT, "o código venceu; peça outro")
        except asyncio.CancelledError:
            raise
        except Exception:
            # A mensagem da biblioteca pode trazer o código: só o tipo vai para o registro.
            _log.error("o pareamento da TV falhou por um erro inesperado")
            self._failure = (PAIR_FAILED, "o pareamento falhou; tente de novo")

    async def _finish(self, command: Command, code: str) -> CommandResult:
        task, pending = self._task, self._code
        if task is None or pending is None or task.done():
            # O pareamento já acabou sozinho (código vencido, TV desistiu): vale a causa guardada.
            failure, self._failure = self._failure, None
            self._task = None
            self._code = None
            if failure is not None:
                return CommandResult(command.id, ResultStatus.FAILED, failure[1], failure[0])
            return CommandResult(
                command.id,
                ResultStatus.REJECTED,
                "não há pareamento esperando o código; peça o código na TV primeiro",
                PAIR_NOT_STARTED,
            )
        if not pending.done():
            pending.set_result(code)
        try:
            await asyncio.wait_for(asyncio.shield(task), self._step_seconds)
        except TimeoutError:
            await self._cancel()
            return CommandResult(
                command.id,
                ResultStatus.FAILED,
                "a TV demorou a responder ao código; peça outro",
                PAIR_TIMEOUT,
            )
        failure, self._failure = self._failure, None
        self._task = None
        self._code = None
        if failure is not None:
            return CommandResult(command.id, ResultStatus.FAILED, failure[1], failure[0])
        # Pareou: responde já e reabre a sessão em seguida (o app confere o resultado pelo estado).
        self._reopen = asyncio.get_running_loop().create_task(self._reopen_session())
        return CommandResult(command.id, ResultStatus.OK)

    async def _reopen_session(self) -> None:
        """Abre a sessão sem ninguém usando o controle; uma recusa mantém `not_paired` no estado."""
        try:
            await self._on_paired()
        except TvSessionError as exc:
            _log.info("pareamento concluído; a sessão não abriu (%s)", exc.code)
        except Exception:
            _log.exception("falha ao abrir a sessão depois do pareamento")
