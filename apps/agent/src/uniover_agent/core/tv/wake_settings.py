"""Conferência dos ajustes que deixam a TV TCL ligar pela rede, e o que contar ao app.

Só lê. A leitura vai junto com a avaliação diária que a limpeza já faz na primeira sessão do dia
(`TvCleanupScheduler`): nenhum laço novo, um comando curto por dia, pelo mesmo canal ADB e com a
mesma trava dos outros caminhos automáticos (que nunca abrem o aviso de permissão na TV).

O que se sabe (TCL C06, Android TV 11, lido pelo ADB em 09/11):

- "Screenless service" (Configurações > Sistema > Energia) é `Settings.Secure smart_audio_switch`:
  dá para conferir; `null` ou `0` é desligado.
- "Networked standby" (Configurações > Rede e Internet) e "Quick Start" (Sistema > Energia) são
  gravados pelo serviço próprio da TCL, sem chave em `settings`: não há leitura simples, e o app
  só os cita no passo a passo.
- `persist.tcl.powerloss=true` acompanha o "liga quando a energia volta" que se viu nela: é o que
  autoriza sugerir "tire da tomada e ligue de novo" quando ligar pela rede não deu certo.

Em TV de outra marca nada é avisado: a chave lida não quer dizer nada fora da TCL.
"""

import logging
from collections.abc import Callable
from typing import Final

from uniover_agent.ports import AdbError, TvAdbCleanup, WakeSettings

_log = logging.getLogger(__name__)

# Os valores do campo `wakeHints` do `tv.state.v1`.
SCREENLESS_OFF: Final = "screenless_off"
REPLUG: Final = "replug"


class WakeSettingsCheck:
    """Guarda a última leitura e se o último Wake-on-LAN ficou sem resposta; avisa quando muda."""

    def __init__(self, adb: TvAdbCleanup) -> None:
        self._adb = adb
        self._settings: WakeSettings | None = None
        self._wake_failed = False
        self._listeners: list[Callable[[], None]] = []

    @property
    def hints(self) -> tuple[str, ...]:
        """O que o app deve mostrar agora (vazio: nada a dizer)."""
        settings = self._settings
        if settings is None or not settings.tcl:
            return ()
        hints: list[str] = []
        if settings.screenless is False:
            hints.append(SCREENLESS_OFF)
        if self._wake_failed and settings.power_restore:
            hints.append(REPLUG)
        return tuple(hints)

    def on_change(self, listener: Callable[[], None]) -> None:
        """Chamado (síncrono, no laço de eventos) quando `hints` muda."""
        self._listeners.append(listener)

    async def check(self) -> bool:
        """Uma leitura; devolve se a TV respondeu. Sem resposta, o que se sabia continua valendo."""
        try:
            settings = await self._adb.wake_settings()
        except AdbError as exc:
            _log.info("ajustes de ligar pela rede não lidos agora (%s)", exc.code)
            return False
        self._apply(lambda: setattr(self, "_settings", settings))
        if settings.tcl and settings.screenless is False:
            _log.warning(
                "TV TCL com o Screenless service desligado: ligar pelo celular pode não funcionar"
            )
        return True

    def wake_failed(self) -> None:
        """O Wake-on-LAN saiu e a TV não respondeu no tempo de espera."""
        self._apply(lambda: setattr(self, "_wake_failed", True))

    def tv_answered(self, _elapsed: float = 0.0) -> None:
        """A sessão abriu: a TV está de pé, e a sugestão de tirar da tomada não vale mais."""
        self._apply(lambda: setattr(self, "_wake_failed", False))

    def _apply(self, change: Callable[[], None]) -> None:
        before = self.hints
        change()
        if self.hints == before:
            return
        for listener in self._listeners:
            try:
                listener()
            except Exception:
                _log.exception("falha ao avisar a mudança dos ajustes de ligar pela rede")
