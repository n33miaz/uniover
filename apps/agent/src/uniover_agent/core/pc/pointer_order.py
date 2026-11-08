"""Diagnóstico da ordem dos movimentos do mouse que chegam em vários pedidos ao mesmo tempo.

O app manda o movimento em pedidos HTTP paralelos, cada um com `seq` crescente, e a API não garante
que eles saiam na ordem em que entraram. O movimento é um deslocamento RELATIVO e a soma de
deslocamentos não depende da ordem: um pedido que chega depois de um mais novo é aplicado do mesmo
jeito (descartá-lo faria o ponteiro parar curto do dedo). Só a idade descarta um movimento (ver
`freshness`). O `seq` serve para duas coisas, e nenhuma decide se o movimento vale:
- saber se o movimento chegou fora de ordem (diagnóstico: uma sequência longa deles é avisada);
- reconhecer uma sessão nova, para a marca "maior número visto" nunca ficar presa a um contador que
  recomeçou: ela é esquecida depois de `IDLE_RESET_SECONDS` sem movimento numerado, quando chega um
  número muito menor que a marca (`RESTART_GAP`) e quando a conexão cai (`reset`).

Mensagem sem `seq` (o sinal de vida do botão apertado, ou um app antigo) nunca conta como atrasada e
não mexe na marca.
"""

from typing import Final

# Mais que isto sem movimento numerado e a marca é esquecida (a página recarregou, ou o dedo parou).
IDLE_RESET_SECONDS: Final = 2.0
# Diferença para baixo que já não é reordenação (o app tem poucos pedidos em voo) e sim um contador
# que recomeçou.
RESTART_GAP: Final = 256


class PointerSequence:
    """Diz se um movimento numerado chegou depois de um mais novo, dado o maior número já visto."""

    def __init__(self) -> None:
        self._newest: int | None = None
        self._seen_at = 0.0

    def is_late(self, seq: int | None, now: float) -> bool:
        """`True` se o movimento chegou depois de um mais novo (`now`: relógio do agente).

        Nunca decide descartar: quem chama aplica o movimento de qualquer jeito.
        """
        if seq is None:
            return False
        newest = self._newest
        if newest is not None and now - self._seen_at <= IDLE_RESET_SECONDS:
            if seq <= newest and newest - seq <= RESTART_GAP:
                self._seen_at = now  # a sessão segue viva: o prazo de esquecimento conta daqui
                return True
        self._newest = seq
        self._seen_at = now
        return False

    def reset(self) -> None:
        """Esquece a marca (a conexão caiu: o que vier depois é de uma sessão nova)."""
        self._newest = None
