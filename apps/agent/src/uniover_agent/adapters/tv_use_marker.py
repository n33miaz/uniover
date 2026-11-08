r"""A marca de "alguém usou a TV (ou o controle do PC) há pouco": a data de `runtime\tv-last-use`
(ou de `runtime\pc-last-use`, que segue o mesmo desenho com o uso do controle do PC).

A atualização do agente reinicia o processo, e isso derruba por alguns segundos o controle da TV.
Quem decide atualizar (o `self-update`, outro processo) precisa saber se a TV está sendo usada, e a
sessão da TV só existe aqui dentro. O jeito mais simples e barato de passar a informação é um
arquivo: a **data** dele é o instante do último uso real (comando, toque na tela do controle); o
conteúdo não importa.

Só a data muda, e só quando o instante mudou: com o disco cheio, mudar a data de um arquivo que já
existe não aloca bloco (o supervisor o cria antes de o agente subir, como faz com o `last-alive`).
Sem uso desde que o agente subiu, o arquivo não é tocado, e o uso de um agente anterior ainda vale
pela data que ele deixou.

Nada aqui levanta erro: é uma pista para adiar uma atualização, e falhar é o mesmo que "TV parada".
"""

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Final

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

MARKER_FILE: Final = "tv-last-use"
# A mesma marca para o controle do PC (touchpad, teclado, mídia): quem atualiza lê as duas.
PC_MARKER_FILE: Final = "pc-last-use"
# De quanto em quanto tempo olha se houve uso novo; a marca atrasa, no máximo, isto.
POLL_SECONDS: Final = 15.0
# Diferença menor que isto entre dois usos não vale uma gravação.
_MIN_STEP_SECONDS: Final = 1.0


class TvUseMarker:
    """Grava no arquivo o instante do último uso da TV (pela idade que a sessão informa)."""

    def __init__(
        self,
        path: Path,
        seconds_since_use: Callable[[], float | None],
        clock: Clock,
        *,
        wall: Callable[[], float] = time.time,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self._path = path
        self._since_use = seconds_since_use
        self._clock = clock
        self._wall = wall
        self._poll = poll_seconds
        self._written: float | None = None
        self._failed = False

    def sync(self) -> bool:
        """Leva o uso mais recente para a data do arquivo; devolve se gravou."""
        age = self._since_use()
        if age is None:
            return False
        stamp = self._wall() - age
        if self._written is not None and abs(stamp - self._written) < _MIN_STEP_SECONDS:
            return False
        try:
            self._touch(stamp)
        except OSError as exc:
            if not self._failed:
                self._failed = True
                _log.info("não consegui gravar a marca de uso da TV (%s)", type(exc).__name__)
            return False
        self._failed = False
        self._written = stamp
        return True

    def _touch(self, stamp: float) -> None:
        try:
            os.utime(self._path, (stamp, stamp))
        except FileNotFoundError:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(FileExistsError):
                self._path.touch(exist_ok=False)
            os.utime(self._path, (stamp, stamp))

    async def run(self) -> None:
        """Laço de fundo: confere o uso até ser cancelado."""
        while True:
            await self._clock.sleep(self._poll)
            try:
                await asyncio.to_thread(self.sync)
            except Exception:
                _log.exception("falha ao gravar a marca de uso da TV; sigo vigiando")
