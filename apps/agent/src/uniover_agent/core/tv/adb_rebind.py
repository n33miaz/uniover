"""Refazer o registro da permissão do ADB para o aparelho de agora (`tv.adb.rebind.v1`).

O agente se recusa a conectar quando outro MAC responde no endereço da TV com permissão (outro
aparelho pode ter tomado o IP). Se o dono sabe que é a mesma TV (trocou de Wi-Fi para cabo, por
exemplo), esta é a saída: ele confirma no app, e só então o registro passa ao MAC de agora. É uma
ação explícita, auditada pela API; o agente nunca a faz sozinho, e ela não conecta a nada.
"""

import logging
from typing import Final, Protocol

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.ports import AdbError

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `tv.adb.rebind.v1` a quem a tem.
ADB_REBIND_CAPABILITY: Final = "tv.adb.rebind.v1"


class RebindAdb(Protocol):
    """O canal ADB: refaz o registro para o aparelho de agora (sem conectar). Levanta `AdbError`."""

    async def rebind_registration(self) -> None: ...


def tv_adb_rebind_handler(adb: RebindAdb) -> Handler:
    """`tv.adb.rebind.v1`: a pessoa confirmou que o aparelho do endereço é a mesma TV."""

    async def handle(command: Command) -> CommandResult:
        try:
            await adb.rebind_registration()
        except AdbError as exc:
            _log.info("registro do ADB não refeito (%s)", exc.code)
            return CommandResult(command.id, ResultStatus.FAILED, exc.message, exc.code)
        return CommandResult(command.id, ResultStatus.OK)

    return handle
