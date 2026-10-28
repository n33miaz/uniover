"""Driver do controle da TV: sessão, comandos e avisos de estado.

O gerenciador de sessão conhece este contrato, não a implementação Android ou Samsung. Cada
fabricante traduz as teclas e o protocolo de rede no adaptador que o implementa.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from uniover_agent.ports.tv_channel import TvChannel


@dataclass(frozen=True, slots=True)
class TextFieldStatus:
    """Estado do campo em foco que a Android TV informa pelo Remote v2."""

    value: str
    start: int
    end: int
    label: str
    counter: int


class TvDriver(TvChannel, Protocol):
    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        """Aperta uma tecla do contrato do agente."""
        ...

    async def launch_link(self, link: str) -> None:
        """Abre um link na TV, quando o protocolo a suportar."""
        ...

    async def send_text(self, text: str) -> None:
        """Insere texto no campo em foco, quando o protocolo a suportar."""
        ...

    def on_power(self, callback: Callable[[bool], None]) -> None:
        """Registra o aviso de energia informado pela TV."""
        ...

    def on_app(self, callback: Callable[[str], None]) -> None:
        """Registra o aviso de app em primeiro plano informado pela TV."""
        ...

    def on_volume(self, callback: Callable[[int], None]) -> None:
        """Registra o aviso de volume informado pela TV."""
        ...

    def on_available(self, callback: Callable[[bool], None]) -> None:
        """Registra quando o canal cai sem o agente o fechar."""
        ...
