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
# A API passa a conexão de uma versão do agente para a seguinte sem derrubar o canal (`hello` com
# `instanceId` e `handover`, fechamento 4410 da antiga). Uma API anterior recusaria o `hello`.
HANDOVER_FEATURE: Final = "agent.handover.v1"
# A API aceita `loopLagMs` no corpo do `agent.keepalive.v1`. Uma anterior recusaria cada batimento
# com o campo e, recusas seguidas, fecharia a conexão: sem ela o batimento sai vazio, como sempre.
KEEPALIVE_LOOP_LAG_FEATURE: Final = "agent.keepalive.loop_lag"


class LoopLagGate:
    """Quando o atraso do laço (`loopLagMs`) pode ir no batimento.

    Só na conexão cuja PRÓPRIA consulta a `features` confirmou a API (geração da conexão): a
    resposta de uma consulta feita para a conexão anterior não vale para a nova, que pode ter caído
    noutra instância durante um deploy. E se a API fechou a conexão por violação de política (1008,
    o que ela faz depois de recusar várias mensagens) enquanto o campo ia, a conexão seguinte não o
    manda: a API não responde a um batimento recusado (ele não tem `correlationId`), então o
    fechamento é o único aviso de recusa que chega.
    """

    def __init__(self) -> None:
        self._generation = 0
        self._approved = -1
        self._blocked = -1
        self._sent = False

    def checking(self) -> Callable[[], None]:
        """Começa a consulta desta conexão; o que devolve dá o aval, se a conexão ainda for esta."""
        generation = self._generation

        def approve() -> None:
            if generation == self._generation and generation != self._blocked:
                self._approved = generation

        return approve

    def allows(self) -> bool:
        return self._approved == self._generation

    def sent(self) -> None:
        self._sent = True

    def connection_lost(self, *, refused: bool) -> None:
        """A conexão caiu; `refused`: a API a fechou por violação de política."""
        if refused and self._sent:
            _log.warning(
                "a API fechou o canal por recusa depois de batimentos com o atraso do laço; a "
                "próxima conexão não o manda"
            )
            self._blocked = self._generation + 1
        self._generation += 1
        self._sent = False


class ApiFeatures:
    def __init__(
        self,
        fetch: Callable[[], Awaitable[frozenset[str] | None]],
        clock: Clock,
        *,
        interval: float = CHECK_INTERVAL_SECONDS,
        known: frozenset[str] = frozenset(),
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._interval = interval
        # O que já se sabe de uma consulta anterior (a da partida da passagem sem queda): o primeiro
        # `hello` declara o mesmo que o da execução que esta substitui. Não dispara aviso nenhum.
        self._known: frozenset[str] = known
        # A API já respondeu ao menos uma vez (mesmo com a lista vazia, que é uma API anterior): sem
        # isso "não listou" e "ainda não sei" seriam a mesma coisa.
        self._answered = bool(known)
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

    async def refresh(self) -> bool:
        """Pergunta à API; resposta ausente (API dormindo, rede) não apaga o que já se sabia.

        Diz se a API respondeu desta vez."""
        try:
            found = await self._fetch()
        except Exception:
            _log.warning("não consegui consultar o que a API aceita", exc_info=True)
            return False
        if found is None:
            return False
        self._answered = True
        if found != self._known:
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
        return True

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
