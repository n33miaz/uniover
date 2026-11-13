"""Porta da lembrança dos ids de `POWER` já aceitos, para sobreviver a reinícios do agente."""

from collections.abc import Mapping
from typing import Protocol


class PowerIdStore(Protocol):
    """Guarda `id do comando -> hora de parede (segundos desde 1970)` dos `POWER` já aceitos.

    `POWER` alterna a TV: o mesmo id executado duas vezes a desfaz. Nenhuma operação levanta:
    arquivo ausente, ilegível ou corrompido vale como lista vazia (recusar o `POWER` travaria o
    botão), e disco cheio ou sem permissão vale como "não consegui gravar"; ambos vão ao registro
    (a gravação como erro, com a causa). Falhou a gravação, o POWER executa assim mesmo.
    """

    def load(self) -> dict[str, float]:
        """Os ids gravados (vazio se não há, ou não se pôde ler, nada confiável)."""
        ...

    def save(self, ids: Mapping[str, float]) -> bool:
        """Grava a lista inteira de forma atômica; `False` se não deu (já registrado como erro).

        Bloqueia no disco: quem chama no laço de eventos usa `asyncio.to_thread`."""
        ...
