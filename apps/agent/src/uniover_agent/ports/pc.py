"""Portas do controle do PC: o que o núcleo pede ao sistema, sem saber que é o Windows.

Tudo é síncrono e rápido (uma chamada de sistema), salvo `PcPower.sleep`, que só volta quando o PC
acorda e por isso o manipulador o roda em outra thread.
"""

from collections.abc import Sequence
from typing import Protocol


class PcUnsupported(Exception):  # noqa: N818 - lê-se como fato: este sistema não faz isto
    """O sistema não consegue executar o pedido (por exemplo, o agente não está no Windows)."""


class PcInput(Protocol):
    """Mouse e teclado do PC."""

    def move(self, dx: int, dy: int) -> None:
        """Move o ponteiro, em pixels relativos à posição atual."""
        ...

    def scroll(self, horizontal: int, vertical: int) -> None:
        """Rola, em unidades de roda (120 = um clique). Positivo: para cima e para a direita."""
        ...

    def click(self, button: str, action: str) -> None:
        """`button`: LEFT, RIGHT ou MIDDLE. `action`: CLICK, DOUBLE, DOWN ou UP."""
        ...

    def key(self, key: str, modifiers: Sequence[str]) -> None:
        """Aperta e solta uma tecla do contrato, com os modificadores seguros enquanto isso."""
        ...

    def type_text(self, text: str) -> None:
        """Digita o texto como caracteres Unicode (não depende do layout do teclado)."""
        ...

    def media(self, action: str, steps: int) -> None:
        """Tecla de mídia do contrato; `steps` repete (volume)."""
        ...


class PcPower(Protocol):
    """Energia do PC."""

    def lock(self) -> None: ...

    def sleep(self) -> None:
        """Suspende. Só volta quando o PC acorda."""
        ...

    def shutdown(self, delay_seconds: int) -> None:
        """Agenda o desligamento com a contagem do Windows (aviso na tela do PC)."""
        ...

    def cancel_shutdown(self) -> None:
        """Cancela a contagem; sem contagem em andamento não é erro."""
        ...


class PcLauncher(Protocol):
    """Abre um programa ou endereço."""

    def launch(self, target: str) -> None: ...
