"""Quando o diagnóstico sai: o que a partida falha deixou na fila vai no primeiro `hello` que der.

O envio normal do diagnóstico pertence à auto-verificação (`self_care`) e só começa quando a API diz
que aceita o diagnóstico (consulta feita em segundo plano, para a primeira conexão nunca esperar
por ela). Isso deixaria a falha de partida, justo o que o dono precisa ver, presa na fila quando a
auto-verificação está desligada ou quando o primeiro `hello` sai antes de a consulta voltar.

Se há `startup.failed` na fila, este objeto espera a consulta (uma vez, com o prazo curto dela)
antes do primeiro `hello`, declara a capacidade nele e envia a fila logo depois, com ou sem
`self_care`. Sem ocorrência dessas na fila, nada muda: o caminho de sempre.
"""

import asyncio
import logging

from uniover_agent.adapters.diagnostics_file import FileDiagnosticStore
from uniover_agent.adapters.startup_trace import KIND as STARTUP_FAILED
from uniover_agent.core.api_features import ApiFeatures
from uniover_agent.core.diagnostics import DIAGNOSTICS_CAPABILITY, DiagnosticsShipper

_log = logging.getLogger(__name__)


class DiagnosticsDelivery:
    def __init__(
        self,
        store: FileDiagnosticStore,
        features: ApiFeatures,
        shipper: DiagnosticsShipper,
        *,
        self_care: bool,
    ) -> None:
        self._store = store
        self._features = features
        self._shipper = shipper
        self._self_care = self_care
        self._pending_startup = False

    async def prepare(self) -> None:
        """Antes da primeira conexão: se há falha de partida a contar, sabe o que a API aceita."""
        try:
            self._pending_startup = await asyncio.to_thread(self._store.has_kind, STARTUP_FAILED)
        except Exception:
            _log.warning("não consegui olhar a fila do diagnóstico", exc_info=True)
            return
        if self._pending_startup:
            await self._features.refresh()

    def capabilities(self) -> tuple[str, ...]:
        """A capacidade do diagnóstico para o `hello`, quando a API a aceita e há o que enviar."""
        if (self._self_care or self._pending_startup) and self._features.supports(
            DIAGNOSTICS_CAPABILITY
        ):
            return (DIAGNOSTICS_CAPABILITY,)
        return ()

    async def after_hello(self) -> None:
        """Logo depois do `hello`: envia a fila (sem `self_care`, só a das falhas de partida)."""
        if not (self._self_care or self._pending_startup):
            return
        await self._shipper.flush()
        if self._pending_startup:
            try:
                self._pending_startup = await asyncio.to_thread(
                    self._store.has_kind, STARTUP_FAILED
                )
            except Exception:
                _log.warning("não consegui olhar a fila do diagnóstico", exc_info=True)
