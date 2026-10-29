"""Leitura do volume da TV Samsung pelo serviço UPnP RenderingControl.

O canal remoto da Samsung só envia teclas: ele não informa o volume. Os modelos que expõem um
renderizador UPnP (DLNA) deixam consultá-lo por SOAP, mas o caminho até o serviço varia, então a
leitura tenta alguns caminhos em cascata e guarda o que funcionou nesta TV:

1. a descrição do renderizador na porta 9197 (`/dmr`), que as TVs Tizen de 2016 em diante servem e
   que traz o `controlURL` certo, sem multicast;
2. o endereço de controle que essas mesmas TVs usam (porta 9197), direto, para firmware cuja
   descrição não responde mas o serviço sim;
3. SSDP (unicast e depois multicast), para o que fugir do padrão. Em PC com várias placas de rede,
   VPN ou firewall o multicast costuma falhar: por isso ele é o último, não o primeiro.

Há modelos sem esse serviço. Nesses a cascata roda poucas vezes (a espera entre as tentativas
cresce) e o resultado negativo fica guardado por bastante tempo, mesmo que a sessão da TV reabra:
nenhuma tecla de volume gera tráfego extra na rede, porque a TV já travou com excesso de consultas.
Mas o serviço de uma TV que acabou de ligar pode demorar a subir: uma primeira falha não é veredito.
Toda falha aqui (rede, XML estranho, resposta vazia) vira "volume desconhecido"; nada disso pode
atrapalhar o controle remoto.
"""

import asyncio
import logging
import socket
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
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
# Porta e caminhos que as TVs Tizen servem para o renderizador UPnP (DLNA).
DMR_PORT = 9197
DMR_DESCRIPTION_PATH = "/dmr"
DMR_CONTROL_PATH = "/upnp/control/RenderingControl1"
# Espera antes de tentar a cascata de novo depois de cada falha seguida. Passados estes passos a TV
# é tratada como "sem o serviço" e só se pergunta de novo depois de `REDISCOVER_SECONDS`.
RETRY_STEPS_SECONDS = (5.0, 15.0, 45.0, 120.0)
# Nomes estáveis dos caminhos: vão para o registro e para o diagnóstico (nunca o endereço da TV).
METHOD_DESCRIPTION = "descricao"
METHOD_DIRECT = "controle-fixo"
METHOD_SSDP = "ssdp"
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


@dataclass(frozen=True, slots=True)
class VolumeAttempt:
    """Um caminho tentado: `ok` é "devolveu um nível"; `detail` nunca traz endereço da TV."""

    method: str
    ok: bool
    detail: str


Candidates = Callable[[], Awaitable[list[str]]]


class SamsungVolume:
    """Lê o nível (0 a 100) pelo UPnP, escolhendo o caminho que funciona nesta TV."""

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
        self._method: str | None = None
        # Falhas seguidas da cascata inteira e quando ela pode rodar de novo.
        self._failures = 0
        self._retry_at = 0.0
        self._resolved_at: float | None = None

    @property
    def available(self) -> bool | None:
        """`True` se há um caminho que funciona; `False` se a TV foi dada como sem o serviço.

        `None` enquanto não há veredito."""
        if self._control is not None:
            return True
        return False if self._failures >= len(RETRY_STEPS_SECONDS) else None

    @property
    def method(self) -> str | None:
        """O nome do caminho que funcionou nesta TV, ou `None`."""
        return self._method

    def reset(self) -> None:
        """Nova conexão: o serviço pode ter subido depois do canal remoto, então tenta de novo.

        Só vale enquanto ainda não há veredito: uma TV dada como sem o serviço não é perguntada a
        cada abertura (só depois de `REDISCOVER_SECONDS`). Um caminho que funcionou segue valendo.
        """
        if self._control is None and self._failures < len(RETRY_STEPS_SECONDS):
            self._retry_at = 0.0
        if self._control is None and self._age() >= REDISCOVER_SECONDS:
            self._forget()

    async def read(self) -> int | None:
        """O nível atual, ou `None`. Nunca levanta: qualquer falha deixa o volume desconhecido."""
        try:
            if self._control is not None:
                level = await self._get_volume(self._control)
                if level is not None:
                    return level
                # O caminho guardado parou de responder (firmware, IP): refaz a cascata agora.
                self._control = None
                self._retry_at = 0.0
            if self._monotonic() < self._retry_at:
                return None
            return await self._cascade(None)
        except Exception as exc:
            _log.info("volume da TV Samsung não lido (%s)", type(exc).__name__)
            return None

    async def diagnose(self) -> list[VolumeAttempt]:
        """Roda a cascata inteira, sem pular nenhum caminho, e conta o que cada um respondeu.

        Só lê (nenhuma tecla é enviada). Um caminho que funciona aqui passa a valer na sessão.
        """
        attempts: list[VolumeAttempt] = []
        self._control = None
        self._retry_at = 0.0
        try:
            await self._cascade(attempts)
        except Exception as exc:
            attempts.append(VolumeAttempt("erro", False, type(exc).__name__))
        return attempts

    async def _cascade(self, attempts: list[VolumeAttempt] | None) -> int | None:
        """Tenta cada caminho na ordem; o primeiro que devolve um nível vira o caminho desta TV.

        Com `attempts` (diagnóstico) anota o que cada caminho respondeu e segue até o fim.
        """
        found: int | None = None
        steps: list[tuple[str, Candidates]] = [
            (METHOD_DESCRIPTION, self._from_description),
            (METHOD_DIRECT, self._from_fixed_control),
            (METHOD_SSDP, self._from_ssdp),
        ]
        for method, candidates in steps:
            if found is not None and attempts is None:
                break
            if found is not None:
                attempts_note(
                    attempts, method, False, "não testado: um caminho anterior já respondeu"
                )
                continue
            found = await self._try_method(method, candidates, attempts)
        if found is None:
            self._failed()
            _log.info("volume da TV Samsung: nenhum caminho UPnP respondeu")
        else:
            self._failures = 0
            self._resolved_at = self._monotonic()
            _log.info("volume da TV Samsung: caminho %s respondeu", self._method)
        return found

    async def _try_method(
        self, method: str, candidates: Candidates, attempts: list[VolumeAttempt] | None
    ) -> int | None:
        try:
            controls = await candidates()
        except Exception as exc:
            attempts_note(attempts, method, False, f"falhou ({type(exc).__name__})")
            return None
        if not controls:
            attempts_note(attempts, method, False, "sem serviço de volume neste caminho")
            return None
        for control in controls:
            # O endereço de controle tem de ser da própria TV: descrição forjada não leva adiante.
            if urlsplit(control).hostname != self._host:
                continue
            level = await self._get_volume(control)
            if level is not None:
                self._control = control
                self._method = method
                attempts_note(attempts, method, True, f"nível {level}")
                return level
        attempts_note(attempts, method, False, "o serviço não devolveu o nível")
        return None

    def _failed(self) -> None:
        self._failures += 1
        self._resolved_at = self._monotonic()
        if self._failures >= len(RETRY_STEPS_SECONDS):
            self._retry_at = self._monotonic() + REDISCOVER_SECONDS
        else:
            self._retry_at = self._monotonic() + RETRY_STEPS_SECONDS[self._failures - 1]

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
            return None

    def _age(self) -> float:
        return float("inf") if self._resolved_at is None else self._monotonic() - self._resolved_at

    def _forget(self) -> None:
        self._control = None
        self._method = None
        self._resolved_at = None
        self._failures = 0
        self._retry_at = 0.0

    async def _from_description(self) -> list[str]:
        control = await self._control_of(f"http://{self._host}:{DMR_PORT}{DMR_DESCRIPTION_PATH}")
        return [] if control is None else [control]

    async def _from_fixed_control(self) -> list[str]:
        return [f"http://{self._host}:{DMR_PORT}{DMR_CONTROL_PATH}"]

    async def _from_ssdp(self) -> list[str]:
        controls: list[str] = []
        locations = await asyncio.to_thread(self._discover or ssdp_locations, self._host)
        for location in locations:
            # A descrição tem de vir da própria TV: um anúncio forjado não leva a outro endereço.
            if urlsplit(location).hostname != self._host:
                continue
            control = await self._control_of(location)
            if control is not None:
                controls.append(control)
        return controls

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


def attempts_note(attempts: list[VolumeAttempt] | None, method: str, ok: bool, detail: str) -> None:
    if attempts is not None:
        attempts.append(VolumeAttempt(method, ok, detail))
