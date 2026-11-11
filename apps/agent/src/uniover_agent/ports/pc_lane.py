"""Porta do lugar onde a faixa do PC roda: o laço do agente ou um laço só da entrada do PC.

O mouse, o teclado, a mídia, o zoom, o volume e o canal direto não podem esperar o resto do agente
(TV, rede, diagnóstico, atualização). Por isso a faixa do PC e o serviço do canal direto ficam
juntos num laço próprio, e tudo o que vem do laço principal entra nele por `post` ou `call`.
"""

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

T = TypeVar("T")


class LaneHost(Protocol):
    """O laço onde a faixa do PC vive."""

    def post(self, callback: Callable[[], None]) -> None:
        """Agenda `callback` no laço da faixa, na ordem em que foi chamado (FIFO).

        Seguro de qualquer thread e nunca bloqueia: quem chama é o laço principal, que não pode
        esperar pela entrada do PC. Se o laço da faixa já parou, o callback é descartado.
        """
        ...

    async def call(
        self, factory: Callable[[], Awaitable[T]], wait_seconds: float | None = None
    ) -> T:
        """Roda a corrotina que `factory` cria no laço da faixa e devolve o resultado.

        Quem chama espera (até `wait_seconds`, se houver); o laço da faixa nunca espera por quem
        chama.
        """
        ...
