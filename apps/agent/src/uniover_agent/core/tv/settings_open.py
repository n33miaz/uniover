"""Abrir na TV a tela de rede ou as configurações (`tv.settings.open.v1`).

A lista de telas é fechada (`SETTINGS_SCREENS`): o corpo da mensagem nunca leva uma ação livre, e o
nome que chega é conferido aqui de novo, mesmo que a API já o tenha validado. O agente nunca abre
uma tela sozinho: o comando só existe quando a pessoa toca no botão do app.
"""

import logging
from typing import Final, Protocol

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.handlers import INVALID_TARGET, failed_result
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError

_log = logging.getLogger(__name__)

# Declarada no `agent.hello.v1`: a API só manda `tv.settings.open.v1` a quem a tem. Só a Android TV
# a declara (a abertura é uma tela do Android pelo ADB); a Samsung não tem canal para isso.
SETTINGS_OPEN_CAPABILITY: Final = "tv.settings.open.v1"

# Os nomes do contrato. O ADB traduz cada um para a ação do Android, também numa lista fechada.
SETTINGS_SCREENS: Final = frozenset({"WIFI", "SETTINGS"})


class Wakeable(Protocol):
    """O que a abertura pede à sessão da TV: aquecer o canal (o `TvSessionManager`)."""

    async def wake(self) -> None: ...


class SettingsAdb(Protocol):
    """O canal ADB: abre uma tela da lista fechada. `ValueError` se o nome não é da lista."""

    async def open_settings(self, screen: str) -> None: ...


class TvSettings:
    """Abre uma tela de configurações da TV pelo ADB, com a sessão quente."""

    def __init__(self, tv: Wakeable, adb: SettingsAdb) -> None:
        self._tv = tv
        self._adb = adb

    async def open_screen(self, screen: str) -> None:
        """Abre a tela. `ValueError` se `screen` não está em `SETTINGS_SCREENS`."""
        if screen not in SETTINGS_SCREENS:
            raise ValueError("tela de configurações desconhecida")
        try:
            await self._tv.wake()
        except TvSessionError as exc:
            # Como na abertura de app: o ADB segue sozinho se o controle remoto não responde.
            _log.info("controle remoto indisponível (%s); seguindo só pelo ADB", exc.code)
        try:
            await self._adb.open_settings(screen)
        except AdbError as exc:
            raise TvSessionError(exc.code, exc.message) from None


def tv_settings_open_handler(settings: TvSettings) -> Handler:
    """`tv.settings.open.v1`: abre a tela de rede (`WIFI`) ou as configurações (`SETTINGS`)."""

    async def handle(command: Command) -> CommandResult:
        screen = command.body.get("screen")
        if not isinstance(screen, str) or screen not in SETTINGS_SCREENS:
            return CommandResult(command.id, ResultStatus.REJECTED, "tela inválida", INVALID_TARGET)
        try:
            await settings.open_screen(screen)
        except ValueError:
            return CommandResult(command.id, ResultStatus.REJECTED, "tela inválida", INVALID_TARGET)
        except TvSessionError as exc:
            return failed_result(command, exc)
        return CommandResult(command.id, ResultStatus.OK)

    return handle
