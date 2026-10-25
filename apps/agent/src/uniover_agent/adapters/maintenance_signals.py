"""Sinais ao supervisor do Windows: os mesmos arquivos que o menu da bandeja usa.

O `run-agent.ps1` olha `runtime/update-now`, `runtime/restart-now` e `runtime/rollback-now` a cada
15 segundos, apaga o arquivo e age (atualiza e reinicia só se há versão nova; reinicia o agente; ou
volta à versão anterior guardada em `app.previous`). Nada aqui encerra o processo: sair por conta
própria passaria pela contagem de quedas do supervisor, que pode reverter uma atualização em teste.
"""

from pathlib import Path
from typing import Final

from uniover_agent.adapters.installation import installation_base

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
        self._previous = previous if previous is not None else base / "app.previous"

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
        return can_roll_back_to(self._previous)
