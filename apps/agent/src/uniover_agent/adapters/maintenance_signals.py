"""Sinais ao supervisor do Windows: os mesmos arquivos que o menu da bandeja usa.

O `run-agent.ps1` olha `runtime/update-now`, `runtime/restart-now` e `runtime/rollback-now` a cada
15 segundos, apaga o arquivo e age (atualiza e reinicia só se há versão nova; reinicia o agente; ou
volta à versão anterior guardada: a do ponteiro ou `app.previous`). Nada aqui encerra o processo:
sair por conta
própria passaria pela contagem de quedas do supervisor, que pode reverter uma atualização em teste.
"""

import logging
import os
import re
import time
from pathlib import Path
from typing import Final

from uniover_agent.adapters.connection_marker import TOKEN_ENV
from uniover_agent.adapters.current_pointer import previous_app
from uniover_agent.adapters.installation import installation_base

_log = logging.getLogger(__name__)

# Arquivo que só as versões com manutenção remota têm. Voltar para uma versão sem ele deixaria o PC
# sem como ser atualizado ou reiniciado à distância: a volta atrás só vale para quem o traz.
_REMOTE_CARE_MARKER: Final = Path("src", "uniover_agent", "adapters", "maintenance_signals.py")


def can_roll_back_to(previous: Path) -> bool:
    """A pasta guarda uma versão anterior que ainda entende a manutenção remota."""
    return (previous / ".version").is_file() and (previous / _REMOTE_CARE_MARKER).is_file()


class RuntimeFlagSignals:
    def __init__(self, runtime: Path | None = None, previous: Path | None = None) -> None:
        base = installation_base()
        self._runtime = runtime if runtime is not None else base / "runtime"
        self._base = base
        self._previous = previous

    def _signal(self, name: str) -> None:
        self._runtime.mkdir(parents=True, exist_ok=True)
        (self._runtime / name).touch()

    def request_update(self) -> None:
        self._signal("update-now")

    def request_restart(self) -> None:
        self._signal("restart-now")

    def request_rollback(self) -> None:
        self._signal("rollback-now")

    def previous_available(self) -> bool:
        # Lido a cada pergunta: o ponteiro muda quando uma versão nova entra.
        return can_roll_back_to(
            self._previous if self._previous is not None else previous_app(self._base)
        )


# Pedido do supervisor para a execução em uso sair de forma ordenada numa passagem sem queda. O
# arquivo traz `handover-exit:` e o código da passagem (32 hexadecimais, o que o supervisor dá à
# versão nova em `UNIOVER_WINDOW_TOKEN`), gravado de uma vez (temporário e renomeação). Quem é a
# versão nova dessa passagem o ignora; quem é a antiga o atende (termina o que tem em curso, solta o
# PC e a TV e sai com 0). Só vale o arquivo bem formado e gravado depois de esta execução começar:
# vazio, pela metade, de formato desconhecido ou velho é ignorado (e registrado uma vez). O
# supervisor apaga o arquivo no fim da passagem e ao subir; o agente apaga o que sobrou ao iniciar.
HANDOVER_EXIT_FILE: Final = "handover-exit"
HANDOVER_EXIT_PREFIX: Final = "handover-exit:"
_EXIT_PATTERN: Final = re.compile(r"handover-exit:([0-9a-f]{32})")


class HandoverExitSignal:
    """O arquivo `runtime/handover-exit` (ver acima), lido pela execução em uso."""

    def __init__(
        self,
        runtime: Path | None = None,
        own_token: str | None = None,
        *,
        started_at: float | None = None,
    ) -> None:
        self._path = (runtime if runtime is not None else installation_base() / "runtime") / (
            HANDOVER_EXIT_FILE
        )
        self._own_token = own_token if own_token is not None else os.environ.get(TOKEN_ENV, "")
        # O pedido tem de ser mais novo que a partida desta execução (relógio de parede, o mesmo
        # que dá a data do arquivo).
        self._started_at = started_at if started_at is not None else time.time()
        self._warned: set[tuple[int, int]] = set()

    def _ignore(self, stat: os.stat_result, why: str) -> bool:
        key = (stat.st_mtime_ns, stat.st_size)
        if key not in self._warned:
            self._warned.add(key)
            _log.warning("pedido de saída ordenada ignorado (%s)", why)
        return False

    def requested(self) -> bool:
        """Há um pedido de saída que vale para esta execução? Nunca levanta erro."""
        try:
            stat = self._path.stat()
            if not self._path.is_file():
                return False
            # Empate não conta como posterior: com relógio de resolução grosseira, um
            # arquivo velho pode ter a mesma marca.
            if stat.st_mtime <= self._started_at:
                return self._ignore(stat, "gravado antes desta execução começar")
            text = self._path.read_text(encoding="ascii", errors="replace")
        except OSError:
            return False
        match = _EXIT_PATTERN.fullmatch(text)
        if match is None:
            return self._ignore(stat, "formato inválido")
        # Com o código da própria passagem, o pedido é para a execução que saiu, não para esta.
        return not (self._own_token and match.group(1) == self._own_token)

    def clear(self) -> None:
        """Apaga o pedido (o que sobrou de uma passagem que não terminou)."""
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            return
