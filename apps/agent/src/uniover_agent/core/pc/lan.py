"""O que é "a rede de casa" para o canal direto: só endereços privados, de enlace local ou ULA.

O canal direto existe para o celular e o PC na MESMA rede. Esta regra vale em dois lugares: os
candidatos ICE (da oferta e os tardios que a API repassa) e o endereço do par que de fato conectou.
Na dúvida a resposta é "não": nome (inclusive `.local`), endereço público, CGNAT, loopback,
multicast, `::ffff:` e qualquer coisa que não seja um literal de IP não são rede de casa.
"""

import ipaddress
from typing import Final

# Em testes de loopback (o celular de mentira é o mesmo processo) o endereço 127.0.0.1 é aceito.
ALLOW_LOOPBACK = False

# As faixas que contam como "a rede de casa". `is_private` do Python não serve sozinho: inclui o
# loopback (que só os testes aceitam) e faixas reservadas que não são de casa (documentação,
# benchmarking, o 192.0.0.0/24 do protocolo); e deixa de fora o CGNAT (100.64/10), que também não é.
_LAN_V4: Final = tuple(
    ipaddress.ip_network(net)
    for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")
)
_LAN_V6: Final = (ipaddress.ip_network("fc00::/7"), ipaddress.ip_network("fe80::/10"))


def is_lan_address(text: str) -> bool:
    """O endereço é privado, de enlace local ou ULA (e não nome, nem endereço público)?

    Só vale o literal de IP; qualquer nome (inclusive `.local`) e qualquer faixa que não seja de uma
    rede de casa dá `False`, e na dúvida a resposta é "não".
    """
    try:
        address = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return False
    if address.is_loopback:
        return ALLOW_LOOPBACK
    if address.is_unspecified or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # `::ffff:a.b.c.d` esconde um IPv4: não se confia (o ICE de verdade não o usa em casa).
        return address.ipv4_mapped is None and any(address in net for net in _LAN_V6)
    return any(address in net for net in _LAN_V4)


def candidate_is_lan(candidate: str) -> bool:
    """O candidato ICE (a linha `candidate:...`, com ou sem `a=`) é UDP e de endereço da rede local?

    Recusa TCP, `relay` (um servidor de terceiros), nome (inclusive `.local`) e endereço fora da
    rede de casa. Uma linha que não dá para ler também é recusada.
    """
    text = candidate.strip().removeprefix("a=").removeprefix("candidate:")
    parts = text.split()
    # <fundação> <componente> <transporte> <prioridade> <endereço> <porta> typ <tipo> ...
    if len(parts) < 8 or parts[6].lower() != "typ":  # noqa: PLR2004
        return False
    if parts[2].lower() != "udp" or parts[7].lower() == "relay":
        return False
    return is_lan_address(parts[4])
