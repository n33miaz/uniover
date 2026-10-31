"""As TVs achadas na rede local, no formato que o agente informa à API.

Usa a mesma varredura do `tv-find`. Nada de endereço ou MAC sai daqui: o `id` é um resumo do
identificador mais estável que a TV entregou (e, sem nenhum, do endereço), então não revela a rede
e continua igual a cada procura.
"""

import hashlib

from uniover_agent.adapters.tv_discovery import DiscoveredTv, find_tvs, same_tv
from uniover_agent.core.tv.discovery import FoundTv, TvFinder
from uniover_agent.core.tv.locator import TvKnown, normalize_mac

_ID_LENGTH = 16


def opaque_id(tv: DiscoveredTv) -> str:
    basis = f"{tv.kind}:{tv.id_hint or tv.host}"
    return hashlib.sha256(f"uniover-nearby:{basis}".encode()).hexdigest()[:_ID_LENGTH]


def is_controlled(tv: DiscoveredTv, host: str | None, known: TvKnown) -> bool:
    """É a TV que este agente já controla? Pelo identificador gravado, o MAC ou o endereço."""
    if known.hint and same_tv(tv, known.hint):
        return True
    if known.mac and tv.mac is not None and normalize_mac(tv.mac) == normalize_mac(known.mac):
        return True
    return host is not None and tv.host == host


def build_finder(host: str | None, known: TvKnown) -> TvFinder:
    async def find() -> list[FoundTv]:
        return [
            FoundTv(opaque_id(tv), tv.kind, tv.name, is_controlled(tv, host, known))
            for tv in await find_tvs()
        ]

    return find
