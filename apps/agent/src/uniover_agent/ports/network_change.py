"""Porta do aviso de que a rede do computador mudou (para reconectar sem esperar o backoff)."""

from collections.abc import Callable
from typing import Protocol


class NetworkChangeWatcher(Protocol):
    """Observa mudanças de rede fora do laço assíncrono e chama `on_change` quando acontecem."""

    def start(self) -> None: ...

    def stop(self) -> None: ...


# Recebe o `on_change` (chamado de outra thread) e devolve o observador, ou `None` quando o sistema
# não oferece a observação: nesse caso o backoff comum segue valendo, sem nenhuma mudança.
NetworkChangeWatcherFactory = Callable[[Callable[[], None]], NetworkChangeWatcher | None]
