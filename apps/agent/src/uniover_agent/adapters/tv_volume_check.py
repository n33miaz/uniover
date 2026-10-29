"""Diagnóstico do volume da TV: quais caminhos de leitura respondem, sem enviar nenhuma tecla.

Serve para saber, numa TV de verdade, o que o agente consegue ler (e por qual caminho) em vez de
adivinhar pelo modelo. Só consulta: nada é apertado, aberto nem mudado na TV. O resultado vai ao
terminal e um resumo (nomes dos caminhos, nunca endereços) ao registro do agente.
"""

import logging
from collections.abc import Callable
from typing import Literal

from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume

_log = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_FAILURE = 1


async def check_volume(
    kind: Literal["android", "samsung"],
    *,
    samsung: SamsungVolume | None = None,
    adb: AdbTv | None = None,
    out: Callable[[str], None] = print,
) -> int:
    """Imprime o que cada caminho respondeu. Sai com 0 se algum deu o nível, com 1 se nenhum deu."""
    if kind == "samsung":
        if samsung is None:
            out("TV Samsung sem endereço configurado: rode `uniover-agent tv-find` antes.")
            return EXIT_FAILURE
        attempts = [(a.method, a.ok, a.detail) for a in await samsung.diagnose()]
    else:
        if adb is None:
            out(
                "Sem o `adb` neste PC: a leitura de reserva da Android TV fica desligada. O canal "
                "remoto da Android TV só se testa com o agente rodando (o nível chega sozinho)."
            )
            return EXIT_FAILURE
        try:
            attempts = await adb.diagnose_volume()
        except Exception as exc:
            out(f"Não consegui falar com a TV pelo adb ({type(exc).__name__}).")
            return EXIT_FAILURE
    for method, ok, detail in attempts:
        out(f"  [{'ok' if ok else '--'}] {method}: {detail}")
    worked = [method for method, ok, _ in attempts if ok]
    _log.info("diagnóstico de volume: responderam %s", ", ".join(worked) or "nenhum caminho")
    if worked:
        out(f"Volume lido por: {', '.join(worked)}.")
        return EXIT_OK
    out(
        "Nenhum caminho devolveu o volume. O controle segue funcionando; o app mostra o toque "
        "sem o número (a TV, ou a soundbar ligada a ela, não informa o nível)."
    )
    return EXIT_FAILURE
