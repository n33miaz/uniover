"""Leitura do volume da TV Samsung pelo serviço UPnP RenderingControl.

O canal remoto da Samsung só envia teclas: ele não informa o volume. Os modelos que expõem um
renderizador UPnP (DLNA) deixam consultá-lo por SOAP, e o endereço do serviço vem da descrição do
dispositivo, achada por SSDP. Porta e caminho variam por modelo e firmware, então nada disso é fixo.

Há modelos sem esse serviço. Nesses a descoberta roda uma vez e o resultado negativo fica guardado
por um tempo, mesmo que a sessão da TV reabra: nenhuma tecla de volume gera tráfego extra na rede,
porque a TV já travou com excesso de consultas. Toda falha aqui (rede, XML estranho, resposta
vazia) vira "volume desconhecido"; nada disso pode atrapalhar o controle remoto.
"""

import asyncio
import logging
import socket
import time
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import httpx

_log = logging.getLogger(__name__)

SSDP_ADDRESS = ("239.255.255.250", 1900)
SSDP_LISTEN_SECONDS = 1.5
CRLF = "\r\n"
UPNP_TIMEOUT_SECONDS = 3.0
# O que foi descoberto (com ou sem o serviço) vale por este tempo, mesmo com a sessão reabrindo.
REDISCOVER_SECONDS = 1800.0
# Leitura que falha depois de descoberto: só descobre de novo se a descoberta já passou deste tempo.
REDISCOVER_AFTER_FAILURE_SECONDS = 120.0
RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"
SSDP_TARGETS = ("upnp:rootdevice", "urn:schemas-upnp-org:device:MediaRenderer:1")

# Descobre os endereços de descrição que a TV anuncia (bloqueante; roda fora do laço de eventos).
Discover = Callable[[str], list[str]]


def _udp_socket() -> socket.socket:
    return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def ssdp_locations(host: str) -> list[str]:
    """Todos os `LOCATION` que o `host` anuncia por SSDP, sem repetição e na ordem de chegada.

    Pergunta primeiro direto à TV (um pacote, sem incomodar a rede); só sem resposta tenta o
    grupo multicast. Uma TV anuncia vários dispositivos (DIAL, IPControl, renderizador...): ficar
    com o primeiro que responde, como o resto do SSDP costuma fazer, erra o serviço de volume.
    """
    found: list[str] = []
    try:
        with _udp_socket() as client:
            client.settimeout(0.25)
            for destination in ((host, SSDP_ADDRESS[1]), SSDP_ADDRESS):
                for target in SSDP_TARGETS:
                    client.sendto(_msearch(target).encode(), destination)
                _collect(client, host, found)
                if found:
                    break
    except OSError:
        _log.info("SSDP indisponível neste PC; o volume da TV Samsung fica desconhecido")
    return found


def _msearch(target: str) -> str:
    return CRLF.join(
        (
            "M-SEARCH * HTTP/1.1",
            "HOST:239.255.255.250:1900",
            'MAN:"ssdp:discover"',
            "MX:1",
            f"ST:{target}",
            "",
            "",
        )
    )


def _collect(client: socket.socket, host: str, found: list[str]) -> None:
    deadline = time.monotonic() + SSDP_LISTEN_SECONDS
    while time.monotonic() < deadline:
        try:
            response, address = client.recvfrom(8_192)
        except TimeoutError:
            continue
        if address[0] != host:
            continue
        location = _header(response.decode("iso-8859-1", errors="replace"), "location")
        if location and location not in found:
            found.append(location)


def _header(text: str, name: str) -> str | None:
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if separator and key.strip().casefold() == name:
            return value.strip() or None
    return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", maxsplit=1)[-1]


def _child_text(element: ElementTree.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name and child.text:
            return child.text.strip()
    return None


def rendering_control_url(description: str, base_url: str) -> str | None:
    """O `controlURL` do RenderingControl da descrição; `None` se não o tem ou se não é XML."""
    try:
        root = ElementTree.fromstring(description)  # noqa: S314 - XML da TV na rede local
    except ElementTree.ParseError:
        return None
    # A descrição pode trazer a base própria dos endereços relativos (libupnp costuma trazer).
    base = next(
        (
            element.text.strip()
            for element in root.iter()
            if _local_name(element.tag) == "URLBase" and element.text
        ),
        base_url,
    )
    for service in root.iter():
        if _local_name(service.tag) != "service":
            continue
        kind = _child_text(service, "serviceType")
        control = _child_text(service, "controlURL")
        if kind and kind.casefold() == RENDERING_CONTROL.casefold() and control:
            return urljoin(base, control)
    return None


def _soap(action: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f'<s:Body><u:{action} xmlns:u="{RENDERING_CONTROL}">'
        "<InstanceID>0</InstanceID><Channel>Master</Channel>"
        f"</u:{action}></s:Body></s:Envelope>"
    )


def _value(document: str, name: str) -> str | None:
    root = ElementTree.fromstring(document)  # noqa: S314 - resposta SOAP da TV na rede local
    for element in root.iter():
        if _local_name(element.tag) == name and element.text:
            return element.text.strip()
    return None


class SamsungVolume:
    """Lê o nível (0 a 100) pelo UPnP, descobrindo o serviço na primeira leitura."""

    def __init__(
        self,
        host: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        discover: Discover | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._host = host
        self._transport = transport
        # Resolvida na hora da chamada: os testes trocam `ssdp_locations` sem abrir a rede.
        self._discover = discover
        self._monotonic = monotonic
        self._control: str | None = None
        self._resolved_at: float | None = None

    @property
    def available(self) -> bool | None:
        """`None` antes da descoberta; depois, se a TV tem o serviço (e vale a pena consultá-lo)."""
        return None if self._resolved_at is None else self._control is not None

    def reset(self) -> None:
        """Nova conexão: descobre de novo, a menos que a descoberta seja recente.

        Reabrir a sessão não repete a busca na rede: uma TV sem o serviço não é perguntada a cada
        abertura. Passado o prazo, a TV pode ter mudado de endereço ou de firmware.
        """
        if self._age() >= REDISCOVER_SECONDS:
            self._forget()

    async def read(self) -> int | None:
        """O nível atual, ou `None`. Nunca levanta: qualquer falha deixa o volume desconhecido."""
        try:
            if self._resolved_at is None:
                self._control = await self._find_control()
                self._resolved_at = self._monotonic()
            if self._control is None:
                return None
            return await self._get_volume(self._control)
        except Exception as exc:
            _log.info("volume da TV Samsung não lido (%s)", type(exc).__name__)
            return None

    async def _get_volume(self, control: str) -> int | None:
        try:
            async with self._client() as client:
                response = await client.post(
                    control,
                    content=_soap("GetVolume"),
                    headers={
                        "Content-Type": 'text/xml; charset="utf-8"',
                        "SOAPACTION": f'"{RENDERING_CONTROL}#GetVolume"',
                    },
                )
                response.raise_for_status()
            level = _value(response.text, "CurrentVolume")
            return None if level is None else max(0, min(100, int(level)))
        except httpx.HTTPError, ElementTree.ParseError, ValueError:
            # O endereço pode ter mudado: uma busca nova, mas só se a anterior não for recente.
            if self._age() >= REDISCOVER_AFTER_FAILURE_SECONDS:
                self._forget()
            return None

    def _age(self) -> float:
        return float("inf") if self._resolved_at is None else self._monotonic() - self._resolved_at

    def _forget(self) -> None:
        self._control = None
        self._resolved_at = None

    async def _find_control(self) -> str | None:
        locations = await asyncio.to_thread(self._discover or ssdp_locations, self._host)
        for location in locations:
            # A descrição tem de vir da própria TV: um anúncio forjado não leva a outro endereço.
            if urlsplit(location).hostname != self._host:
                continue
            control = await self._control_of(location)
            if control is not None and urlsplit(control).hostname == self._host:
                # O registro sai do PC pela manutenção remota: o endereço interno da TV (host, porta
                # e caminho do serviço) não pode ir junto. Basta saber que o serviço foi achado.
                _log.info("volume da TV Samsung: serviço UPnP encontrado")
                return control
        _log.info("a TV Samsung não expõe RenderingControl; o volume fica desconhecido")
        return None

    async def _control_of(self, location: str) -> str | None:
        try:
            async with self._client() as client:
                response = await client.get(location)
                response.raise_for_status()
        except httpx.HTTPError:
            return None
        return rendering_control_url(response.text, str(response.url))

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=UPNP_TIMEOUT_SECONDS)
