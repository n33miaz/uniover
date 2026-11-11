"""O que a API sabe receber além do básico: o agente só usa o opcional que ela diz aceitar.

Uma API anterior recusa o `hello` que declara uma capacidade que ela não conhece (a lista é fechada
no contrato) e isso tiraria o agente do ar durante um deploy em que o agente chega antes da API. Por
isso a capacidade nova só vai no `hello` depois de a rota pública `devices/info` listá-la em
`features`, e o diagnóstico só é enviado a partir daí. Enquanto a API não diz, o que o agente tem a
contar fica na fila local, que é limitada.
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Final

from uniover_agent.ports import Clock

_log = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS: Final = 300.0
# Enquanto a API não disse nada (dormindo, ainda subindo), pergunta de novo logo e vai espaçando.
FIRST_RETRY_SECONDS: Final = 15.0
FEATURES_TIMEOUT_SECONDS: Final = 3.0
# A API aceita `tv.state.v1` com `connection: not_paired` (uma anterior recusaria o estado).
NOT_PAIRED_FEATURE: Final = "tv.state.not_paired"
# A API aceita `tv.state.v1` com `connection: waking` (a TV está ligando; uma anterior o recusaria).
WAKING_FEATURE: Final = "tv.state.waking"
# A API aceita `adbPermission` (granted, missing, pending) no corpo de `tv.state.v1`; uma anterior
# recusaria o campo e perderia o estado inteiro.
ADB_PERMISSION_FEATURE: Final = "tv.state.adb_permission"


class ApiFeatures:
    def __init__(
        self,
        fetch: Callable[[], Awaitable[frozenset[str] | None]],
        clock: Clock,
        *,
        interval: float = CHECK_INTERVAL_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._interval = interval
        self._known: frozenset[str] = frozenset()
        # A API já respondeu ao menos uma vez (mesmo com a lista vazia, que é uma API anterior): sem
        # isso "não listou" e "ainda não sei" seriam a mesma coisa.
        self._answered = False
        self._listeners: list[Callable[[], None]] = []
        # Chamado quando a API passa a listar algo que não listava: o `hello` já enviado não
        # declarou a capacidade nova, e esperar o próximo (5 min) a deixaria sem uso (a presença da
        # TV, por exemplo, só chega a quem a declara).
        self.on_added: Callable[[], Awaitable[None]] | None = None

    def on_change(self, listener: Callable[[], None]) -> None:
        """Avisa quando muda o que a API aceita (o que foi escondido pode ser dito agora)."""
        self._listeners.append(listener)

    def supports(self, feature: str) -> bool:
        return feature in self._known

    @property
    def answered(self) -> bool:
        """A API já disse o que aceita (falha da consulta, partida ou API dormindo: ainda não)."""
        return self._answered

    async def refresh(self) -> None:
        """Pergunta à API; resposta ausente (API dormindo, rede) não apaga o que já se sabia."""
        try:
            found = await self._fetch()
        except Exception:
            _log.warning("não consegui consultar o que a API aceita", exc_info=True)
            return
        if found is not None:
            self._answered = True
        if found is not None and found != self._known:
            added = bool(found - self._known)
            self._known = found
            for listener in self._listeners:
                try:
                    listener()
                except Exception:
                    _log.exception("falha ao avisar a mudança do que a API aceita")
            if added and self.on_added is not None:
                try:
                    await self.on_added()
                except Exception:
                    _log.warning(
                        "não consegui reenviar o hello com a capacidade nova", exc_info=True
                    )

    async def run(self) -> None:
        """Consulta de tempos em tempos: a resposta de hoje manda no próximo `hello`."""
        retry = FIRST_RETRY_SECONDS
        while True:
            await self.refresh()
            if self._known:
                retry = self._interval
                await self._clock.sleep(self._interval)
            else:
                await self._clock.sleep(min(retry, self._interval))
                retry = min(retry * 2, self._interval)
