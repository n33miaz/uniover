"""Portas da aprovação de aparelho novo no PC: onde as decisões ficam e como o dono é perguntado."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class DeviceRecord:
    """A decisão do dono sobre um aparelho: `approved` ou `denied`, o nome que ele viu e quando."""

    state: str
    name: str
    at: float


class DeviceStore(Protocol):
    """As decisões guardadas neste PC (sobrevivem ao reinício do agente)."""

    def load(self) -> dict[str, DeviceRecord]: ...

    def save(self, records: dict[str, DeviceRecord]) -> None: ...

    def api_seen(self) -> bool:
        """A API já listou `pc.device.v1` alguma vez (então "não listou" depois é suspeito)."""
        ...

    def mark_api_seen(self) -> None: ...


class ApprovalPrompt(Protocol):
    """Pergunta ao dono, NO PC, se o aparelho pode controlá-lo."""

    async def ask(self, name: str) -> bool | None:
        """`True` permitiu, `False` recusou, `None` não deu para perguntar (sem janela)."""
        ...

    async def aclose(self) -> None:
        """Fecha a janela que estiver aberta (o agente está encerrando) e espera ela terminar."""
        ...
