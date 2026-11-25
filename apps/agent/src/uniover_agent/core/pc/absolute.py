"""Toque na imagem da tela do PC: do ponto relativo de um monitor ao pixel físico e à posição
absoluta.

O app manda `(m, u, v)`: o monitor como a tela ao vivo o anunciou (`s.mon`) e a posição relativa
dentro dele (0 a 65535 nos dois eixos), mais o tamanho que ele viu (`w`, `h`). Aqui, sem tocar no
sistema:

- `physical_point` acha o monitor na leitura de agora (pixels físicos, como a tela ao vivo os
  mede) e dá o pixel; um monitor que sumiu ou mudou de tamanho é `stale_layout`, e o app espera o
  próximo `s.mon` (clicar no lugar errado é pior que não clicar);
- `normalized` leva o pixel à escala do `SendInput` absoluto sobre o desktop virtual
  (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`): `round((X - vx) * 65535 / (vw - 1))`. A volta
  que o Windows faz cai no mesmo pixel ou no vizinho, qualquer que seja o arredondamento dele, e não
  depende do DPI do processo nem da aceleração do mouse.

O desktop virtual é a união dos retângulos dos monitores, lidos na mesma chamada: os dois nunca
discordam entre si (o que aconteceria lendo um com o DPI do processo e o outro com o da thread).
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol, runtime_checkable

from uniover_agent.ports.pc import PcInputRefused

# Declarada no `hello` (depois de a API listá-la em `features`) e só junto com a tela ao vivo.
PC_ABS_CAPABILITY: Final = "pc.abs.v1"
TAP_TYPE: Final = "pc.tap.v1"
ABS_POINTER_TYPE: Final = "pc.pointer.abs.v1"
# Só pelo canal direto com a tela aberta: pela nuvem são recusadas.
DIRECT_ONLY_TYPES: Final = frozenset({TAP_TYPE, ABS_POINTER_TYPE})
# A recusa de um toque num arranjo de monitores que mudou desde o último `s.mon`.
STALE_LAYOUT: Final = "stale_layout"
# O maior `u`/`v` do contrato (o último pixel do monitor) e o da escala absoluta do Windows.
RELATIVE_MAX: Final = 65535
NORMALIZED_MAX: Final = 65535
# Os limites do contrato.
MAX_MONITOR_ID: Final = 63
MAX_MONITOR_SIDE: Final = 32767
MAX_ABS_SEQ: Final = 2_147_483_647


@dataclass(frozen=True, slots=True)
class MonitorArea:
    """Um monitor no desktop virtual, em pixels físicos (`left`/`top` podem ser negativos)."""

    id: int
    left: int
    top: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class AbsoluteTarget:
    """O ponto pedido: monitor `monitor`, posição relativa `u`/`v` e o tamanho que o app viu."""

    monitor: int
    u: int
    v: int
    width: int
    height: int

    @classmethod
    def from_body(cls, body: Mapping[str, Any]) -> AbsoluteTarget:
        """Do corpo do contrato. O portão já conferiu; isto protege o adaptador de um erro nosso
        (inclusive `True`, que o Python aceita como inteiro)."""
        values = [body.get(key) for key in ("m", "u", "v", "w", "h")]
        limits = (
            (0, MAX_MONITOR_ID),
            (0, RELATIVE_MAX),
            (0, RELATIVE_MAX),
            (1, MAX_MONITOR_SIDE),
            (1, MAX_MONITOR_SIDE),
        )
        for value, (low, high) in zip(values, limits, strict=True):
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise ValueError("posição fora do contrato")
        monitor, u, v, width, height = values
        return cls(monitor, u, v, width, height)  # type: ignore[arg-type]


class LayoutChanged(PcInputRefused):
    """O monitor pedido sumiu ou mudou de tamanho desde o `s.mon` que o app usou."""

    def __init__(self) -> None:
        super().__init__("o arranjo dos monitores mudou", STALE_LAYOUT)


def _rounded(numerator: int, denominator: int) -> int:
    """`numerator / denominator` arredondado para o mais próximo (meio para cima), sem `float`."""
    return (2 * numerator + denominator) // (2 * denominator)


def virtual_desk(monitors: Sequence[MonitorArea]) -> tuple[int, int, int, int]:
    """O retângulo que envolve todos os monitores: `(x, y, largura, altura)`."""
    if not monitors:
        raise LayoutChanged
    left = min(item.left for item in monitors)
    top = min(item.top for item in monitors)
    right = max(item.left + item.width for item in monitors)
    bottom = max(item.top + item.height for item in monitors)
    return left, top, right - left, bottom - top


def physical_point(monitors: Sequence[MonitorArea], target: AbsoluteTarget) -> tuple[int, int]:
    """O pixel físico do ponto pedido; `LayoutChanged` se o monitor não bate com o que o app viu."""
    chosen = next((item for item in monitors if item.id == target.monitor), None)
    if chosen is None or chosen.width != target.width or chosen.height != target.height:
        raise LayoutChanged
    x = chosen.left + _rounded(target.u * (chosen.width - 1), RELATIVE_MAX)
    y = chosen.top + _rounded(target.v * (chosen.height - 1), RELATIVE_MAX)
    return x, y


def normalized(x: int, y: int, desk: tuple[int, int, int, int]) -> tuple[int, int]:
    """O pixel `(x, y)` na escala absoluta do desktop virtual (0 a 65535 nos dois eixos)."""
    left, top, width, height = desk

    def axis(value: int, origin: int, size: int) -> int:
        if size <= 1:
            return 0
        offset = min(max(value - origin, 0), size - 1)
        return _rounded(offset * NORMALIZED_MAX, size - 1)

    return axis(x, left, width), axis(y, top, height)


def locate(
    monitors: Sequence[MonitorArea], target: AbsoluteTarget
) -> tuple[tuple[int, int], tuple[int, int]]:
    """O pixel físico e a posição normalizada do ponto pedido, de uma leitura só dos monitores."""
    point = physical_point(monitors, target)
    return point, normalized(*point, virtual_desk(monitors))


@runtime_checkable
class PcPointerAbsolute(Protocol):
    """O ponteiro absoluto sobre a tela do PC (o adaptador do Windows implementa)."""

    def move_to(self, target: AbsoluteTarget) -> None:
        """Leva o ponteiro ao ponto (`LayoutChanged` se o arranjo mudou)."""
        ...

    def tap(
        self, target: AbsoluteTarget, button: str, action: str, modifiers: Sequence[str] = ()
    ) -> None:
        """Leva o ponteiro ao ponto e clica ali, num lote só. O `UP` sempre solta, mesmo com o
        arranjo mudado (aí sem mover)."""
        ...
