"""Lembrança dos ids de `POWER` já aceitos: nunca executa o mesmo id duas vezes.

`POWER` alterna a TV, então o relógio é o de parede (o monotônico não vale entre reinícios, e no
Windows também avança durante a hibernação). O id novo entra na memória na hora (o leitor o
reconhece se o mesmo id chegar em seguida) e vai a disco logo antes de a tecla executar, fora do
leitor (`persist`). Um agente reiniciado, ou um PC que ficou dias hibernado, ainda reconhece o id
reenviado. Cada id vale 30 dias e a lista guarda no máximo 1000; os mais antigos saem primeiro.

Decisões aceitas, de propósito:

- Falha ao gravar (disco cheio, sem permissão): o POWER executa assim mesmo, com o id só em
  memória, e o erro vai ao registro com a causa. Recusar o botão por falha de disco seria pior
  para o dono, e a API não reenvia comando antigo (ela envia ao vivo, sem fila de reenvio). O
  próximo POWER tenta gravar de novo.
- Saltos do relógio de parede: para trás, ids ficam lembrados por mais tempo (nunca por menos); para
  frente, ids vencem mais cedo. A poda olha o id mais antigo da lista, então um timestamp futuro
  na frente atrasa a saída dos seguintes: erra sempre para o lado de lembrar mais.
- O teto de 1000 ids tira os mais antigos mesmo que ainda estejam na validade; um uso humano não
  chega a 1000 POWER em 30 dias.
"""

import asyncio
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from typing import Final

from uniover_agent.core.domain import CommandResult
from uniover_agent.ports.power_ids import PowerIdStore

POWER_ID_SECONDS: Final = 30 * 24 * 60 * 60.0
POWER_ID_CAPACITY: Final = 1000


class PowerIds:
    def __init__(
        self,
        store: PowerIdStore | None = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._wall = wall_clock
        self._ids: OrderedDict[str, float] = OrderedDict()
        # Os que vieram do disco não têm resposta guardada (a memória é só deste processo).
        self._restored: set[str] = set()
        self._results: dict[str, CommandResult] = {}
        self._dirty = False
        self._saving = asyncio.Lock()
        self.merge(store.load() if store is not None else {})

    def admit(self, command_id: str) -> bool:
        """`True` se o id é novo (já lembrado na memória); `False` se já tinha chegado.

        Só memória: não bloqueia o leitor. A gravação em disco é `persist`.
        """
        self._prune()
        if command_id in self._ids:
            return False
        self._ids[command_id] = self._wall()
        self._dirty = True
        self._prune()
        return True

    async def persist(self) -> None:
        """Grava a lista em disco sem bloquear o laço; chamada antes de o POWER executar."""
        store = self._store
        if store is None:
            return
        async with self._saving:
            if not self._dirty:
                return
            snapshot = dict(self._ids)
            self._dirty = False
            if not await asyncio.to_thread(store.save, snapshot):
                # Falha já registrada pelo adaptador; o próximo POWER tenta de novo.
                self._dirty = True

    def read_store(self) -> dict[str, float]:
        """Lê o disco (bloqueia: chamar em outra thread). Entrada de `merge`."""
        return self._store.load() if self._store is not None else {}

    def merge(self, stored: Mapping[str, float]) -> None:
        """Junta o que está em disco com o que já há na memória (vale o timestamp mais novo).

        Na passagem sem queda a execução antiga ainda grava depois que a nova nasce: a nova junta de
        novo o arquivo ao virar dona.
        """
        for command_id, stamp in stored.items():
            known = self._ids.get(command_id)
            if known is None:
                self._restored.add(command_id)
            if known is None or stamp > known:
                self._ids[command_id] = stamp
        # Do mais antigo para o mais novo: o teto tira sempre os da frente.
        ordered = sorted(self._ids.items(), key=lambda item: item[1])
        self._ids = OrderedDict(ordered)
        self._prune()

    def result_of(self, command_id: str) -> CommandResult | None:
        return self._results.get(command_id)

    def was_restored(self, command_id: str) -> bool:
        """O id veio do disco: a execução que o aceitou foi de outro processo."""
        return command_id in self._restored

    def remember_result(self, command_id: str, result: CommandResult) -> None:
        if command_id in self._ids:
            self._results[command_id] = result

    def _prune(self) -> None:
        now = self._wall()
        while self._ids:
            oldest, stamp = next(iter(self._ids.items()))
            if len(self._ids) <= POWER_ID_CAPACITY and now - stamp <= POWER_ID_SECONDS:
                break
            del self._ids[oldest]
            self._results.pop(oldest, None)
            self._restored.discard(oldest)
