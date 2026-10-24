"""Controle Samsung Tizen pelo WebSocket local e estado de energia pelo REST.

`samsungtvws` é síncrona; cada chamada fica numa thread para nunca parar o recebimento de comandos
da API. O token entra direto no cliente, pois a biblioteca só precisa do arquivo quando não recebe
o token explicitamente.
"""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx
from samsungtvws import SamsungTVWS
from samsungtvws import helper as samsung_helper

from uniover_agent.adapters.tv_discovery import samsung_identity
from uniover_agent.core.tv.locator import TvIdentity
from uniover_agent.ports import TvNotPaired, TvUnreachable

_log = logging.getLogger(__name__)

SAMSUNG_PORT = 8002
SAMSUNG_REST_PORT = 8001
SAMSUNG_TIMEOUT_SECONDS = 5.0
SAMSUNG_APP_TIMEOUT_SECONDS = 3.0
SAMSUNG_APP_LIST_TIMEOUT_SECONDS = 5.0
SAMSUNG_APP_ICON_TIMEOUT_SECONDS = 1.0
SAMSUNG_APP_PROBE_CONCURRENCY = 8
# Ícones seguidos sem resposta que encerram o pedido de ícones (a TV está sem fôlego).
SAMSUNG_ICON_MAX_FAILURES = 3
# Volume: o serviço UPnP de renderização que a própria TV expõe. Lido só depois de uma tecla.
SAMSUNG_UPNP_PORT = 9197
SAMSUNG_VOLUME_TIMEOUT_SECONDS = 2.0
_VOLUME_SOAP = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
    '<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">'
    "<InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume></s:Body></s:Envelope>"
)
_VOLUME_VALUE = re.compile(r"<CurrentVolume>\s*(\d{1,3})\s*</CurrentVolume>")

# Estes identificadores são publicados só quando o endpoint da própria TV confirma que o app está
# instalado. A Samsung não disponibiliza uma lista confiável de apps em todos os modelos Tizen.
SAMSUNG_APP_IDS = (
    "111299001912",  # YouTube
    "3201907018807",  # Netflix
    "3201910019365",  # Prime Video
    "3201901017640",  # Disney+
    "3201606009684",  # Spotify
    "3201908019022",  # Globoplay
    "3201908019041",  # Apple Music
    "3202301029760",  # Max
    "3201601007230",  # HBO Max
    "3201611010983",  # YouTube Kids
    "3201807016597",  # Apple TV
    "3201808016802",  # Pluto TV
    "3201710014981",  # Paramount+
    "3201608010191",  # Deezer
    "3202203026841",  # Twitch
    "3202010022079",  # Internet
)

# Teclas aceitas pelo contrato da API, traduzidas para o nome do controle Samsung.
SAMSUNG_KEYS: dict[str, str] = {
    "UP": "KEY_UP",
    "DOWN": "KEY_DOWN",
    "LEFT": "KEY_LEFT",
    "RIGHT": "KEY_RIGHT",
    "OK": "KEY_ENTER",
    "BACK": "KEY_RETURN",
    "HOME": "KEY_HOME",
    "MENU": "KEY_MENU",
    "VOLUME_UP": "KEY_VOLUP",
    "VOLUME_DOWN": "KEY_VOLDOWN",
    "MUTE": "KEY_MUTE",
    "CHANNEL_UP": "KEY_CHUP",
    "CHANNEL_DOWN": "KEY_CHDOWN",
    "PLAY_PAUSE": "KEY_PLAY_PAUSE",
    "PLAY": "KEY_PLAY",
    "PAUSE": "KEY_PAUSE",
    "STOP": "KEY_STOP",
    "REWIND": "KEY_REWIND",
    "FAST_FORWARD": "KEY_FF",
    "MEDIA_NEXT": "KEY_NEXT",
    "MEDIA_PREVIOUS": "KEY_PREVIOUS",
    "POWER": "KEY_POWER",
    "INFO": "KEY_INFO",
    "INPUT": "KEY_SOURCE",
    **{f"NUM_{number}": f"KEY_{number}" for number in range(10)},
}


class SamsungClient(Protocol):
    token: str | None

    def open(self) -> object: ...

    def close(self) -> None: ...

    def send_key(
        self,
        key: str,
        times: int = 1,
        key_press_delay: float | None = None,
        cmd: str = "Click",
    ) -> None: ...

    def run_app(self, app_id: str, app_type: str = "DEEP_LINK", meta_tag: str = "") -> None: ...

    def app_list(self) -> list[dict[str, Any]] | None: ...

    def app_icon(self, icon_path: str) -> str | None: ...


SamsungFactory = Callable[[str, str | None, str], SamsungClient]
PowerFetcher = Callable[[str], Awaitable[bool | None]]
IdentitySink = Callable[[TvIdentity], None]


class _SamsungTvWs(SamsungTVWS):
    """Pequena extensão da biblioteca para o evento EDEN de ícones, ainda não exposto por ela."""

    def app_icon(self, icon_path: str) -> str | None:
        # A resposta vem no mesmo socket síncrono usado pelo `app_list`; não iniciamos o loop de
        # eventos porque o driver mantém a conexão quente e faz as chamadas numa thread.
        self._ws_send(
            {
                "method": "ms.channel.emit",
                "params": {
                    "event": "ed.apps.icon",
                    "to": "host",
                    "data": {"iconPath": icon_path},
                },
            }
        )
        if self.connection is None:
            return None
        try:
            response = samsung_helper.process_api_response(self.connection.recv())
        except Exception:
            return None
        if response.get("event") != "ed.apps.icon":
            return None
        data = response.get("data")
        if not isinstance(data, dict):
            return None
        image = data.get("imageBase64")
        return image if isinstance(image, str) and image else None


def _default_factory(host: str, token: str | None, name: str) -> SamsungClient:
    # A pausa padrão da biblioteca é um segundo por tecla, desnecessária para toques únicos.
    return _SamsungTvWs(
        host,
        token=token,
        port=SAMSUNG_PORT,
        timeout=SAMSUNG_TIMEOUT_SECONDS,
        key_press_delay=0,
        name=name,
    )


async def fetch_samsung_info(host: str) -> dict[str, Any] | None:
    """O REST da própria TV (`/api/v2/`): energia, `duid` e MAC Wi-Fi numa só leitura."""
    url = f"http://{host}:{SAMSUNG_REST_PORT}/api/v2/"
    try:
        async with httpx.AsyncClient(timeout=SAMSUNG_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError, ValueError, TypeError:
        return None
    return data if isinstance(data, dict) else None


def power_from_info(info: dict[str, Any] | None) -> bool | None:
    device = info.get("device") if info else None
    value = device.get("PowerState") if isinstance(device, dict) else None
    if not isinstance(value, str):
        return None
    lowered = value.casefold()
    if lowered == "on":
        return True
    if lowered in {"off", "standby"}:
        return False
    return None


async def fetch_samsung_power(host: str) -> bool | None:
    """Lê `PowerState` sem tornar a abertura do controle dependente do REST."""
    return power_from_info(await fetch_samsung_info(host))


class SamsungTvDriver:
    """Driver Samsung com conexão quente; o gerente decide quando abrir e hibernar."""

    def __init__(  # noqa: PLR0913 - cada dependência é injetada para testar o protocolo isolado
        self,
        host: str,
        token: str | None,
        name: str,
        *,
        factory: SamsungFactory = _default_factory,
        fetch_power: PowerFetcher | None = None,
        on_identity: IdentitySink | None = None,
        save_token: Callable[[str], None] | None = None,
        app_ids: tuple[str, ...] = (),
        rest_transport: httpx.AsyncBaseTransport | None = None,
        ws_timeout_seconds: float = SAMSUNG_TIMEOUT_SECONDS,
        app_timeout_seconds: float = SAMSUNG_APP_TIMEOUT_SECONDS,
        app_list_timeout_seconds: float = SAMSUNG_APP_LIST_TIMEOUT_SECONDS,
    ) -> None:
        self._host = host
        self._token = token
        self._name = name
        self._factory = factory
        self._fetch_power = fetch_power
        self._on_identity = on_identity
        self._save_token = save_token
        self._app_ids = tuple(dict.fromkeys((*SAMSUNG_APP_IDS, *app_ids)))
        self._rest_transport = rest_transport
        self._ws_timeout_seconds = ws_timeout_seconds
        self._app_timeout_seconds = app_timeout_seconds
        self._app_list_timeout_seconds = app_list_timeout_seconds
        self._app_icon_timeout_seconds = SAMSUNG_APP_ICON_TIMEOUT_SECONDS
        self._client: SamsungClient | None = None
        self._connected = False
        self._power: list[Callable[[bool], None]] = []
        self._app: list[Callable[[str], None]] = []
        self._volume: list[Callable[[int], None]] = []
        self._available: list[Callable[[bool], None]] = []

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        if self._connected:
            return
        if not self._token:
            raise TvNotPaired("a TV Samsung ainda não foi pareada")
        client = self._factory(self._host, self._token, self._name)
        try:
            await self._call_client(client.open)
        except Exception:
            raise TvUnreachable("a TV Samsung não respondeu ao controle remoto") from None
        self._client = client
        self._connected = True
        # A TV pode renovar o token no aceite do canal; guardar a versão nova evita novo aviso.
        if client.token and client.token != self._token:
            self._token = client.token
            if self._save_token is not None:
                self._save_token(client.token)
        power = await self._read_power_and_identity()
        if power is not None:
            for callback in self._power:
                callback(power)

    async def _read_power_and_identity(self) -> bool | None:
        """Uma só leitura do REST por abertura: energia agora e quem a TV diz ser (para gravar o
        `duid` e o MAC, que reencontram a TV se o IP mudar)."""
        if self._fetch_power is not None:
            return await self._fetch_power(self._host)
        info = await fetch_samsung_info(self._host)
        identity = samsung_identity(info)
        if identity is not None and self._on_identity is not None:
            try:
                self._on_identity(identity)
            except Exception:
                _log.exception("falha ao guardar a identidade da TV")
        return power_from_info(info)

    async def read_volume(self) -> int | None:
        """Volume atual pelo UPnP da TV; `None` se ela não responde (nunca levanta).

        Só é chamado logo depois de uma tecla de volume: não há sondagem periódica.
        """
        url = f"http://{self._host}:{SAMSUNG_UPNP_PORT}/dmr/upnp/control/RenderingControl1"
        headers = {
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPAction": '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"',
        }
        try:
            async with httpx.AsyncClient(
                transport=self._rest_transport, timeout=SAMSUNG_VOLUME_TIMEOUT_SECONDS
            ) as client:
                response = await client.post(url, content=_VOLUME_SOAP, headers=headers)
        except httpx.HTTPError:
            return None
        match = _VOLUME_VALUE.search(response.text) if response.is_success else None
        return min(100, int(match.group(1))) if match else None

    async def disconnect(self) -> None:
        client, self._client = self._client, None
        self._connected = False
        if client is not None:
            try:
                await self._call_client(client.close)
            except Exception:
                _log.warning("falha ao fechar o canal Samsung")

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        mapped = SAMSUNG_KEYS.get(key)
        if mapped is None:
            raise ValueError("tecla desconhecida")
        command = {"SHORT": "Click", "START_LONG": "Press", "END_LONG": "Release"}.get(direction)
        if command is None:
            raise ValueError("direção desconhecida")
        client = self._require_client()
        try:
            await self._call_client(client.send_key, mapped, 1, 0, command)
        except Exception:
            self._lost()
            raise TvUnreachable("o canal da TV Samsung foi fechado") from None

    async def launch_link(self, link: str) -> None:
        # A biblioteca só expõe abertura de app por id; links não têm contrato Samsung confiável.
        del link
        raise ValueError("links não são suportados pela TV Samsung")

    async def send_text(self, text: str) -> None:
        # O canal remoto desta família não expõe IME. O handler não o chama e devolve unsupported.
        del text
        raise ValueError("texto não é suportado pela TV Samsung")

    async def app_list(self) -> list[dict[str, Any]] | None:
        """Pede a lista detalhada pelo WS e usa o catálogo REST nos firmwares que não respondem."""
        client = self._client
        if client is not None and self._connected:
            try:
                listed = await self._call_client(client.app_list)
            except Exception:
                listed = None
            if listed:
                return await self._with_icons(client, listed)
        return await self._rest_app_list()

    async def _rest_app_list(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(transport=self._rest_transport) as client:
            semaphore = asyncio.Semaphore(SAMSUNG_APP_PROBE_CONCURRENCY)
            tasks = [
                asyncio.create_task(self._probe_app(client, semaphore, app_id))
                for app_id in self._app_ids
            ]
            done, pending = await asyncio.wait(tasks, timeout=self._app_list_timeout_seconds)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            results = [task.result() for task in tasks if task in done]
        return [result for result in results if result is not None]

    async def _with_icons(
        self, client: SamsungClient, listed: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Acrescenta a imagem base64 que o EDEN devolve para cada caminho de ícone da lista."""
        enriched: list[dict[str, Any]] = []
        failures = 0
        for item in listed:
            copy = dict(item)
            icon_path = item.get("icon")
            # TV que não responde aos ícones: depois de algumas falhas seguidas, para de pedir.
            if isinstance(icon_path, str) and icon_path and failures < SAMSUNG_ICON_MAX_FAILURES:
                try:
                    image = await self._call_client(
                        client.app_icon, icon_path, wait_seconds=self._app_icon_timeout_seconds
                    )
                except Exception:
                    image = None
                if isinstance(image, str) and image:
                    copy["imageBase64"] = image
                    failures = 0
                else:
                    failures += 1
            enriched.append(copy)
        return enriched

    async def run_app(self, app_id: str) -> None:
        if await self._launch_app_rest(app_id):
            return
        client = self._require_client()
        try:
            await self._call_client(client.run_app, app_id, "NATIVE_LAUNCH", "")
        except Exception:
            self._lost()
            raise TvUnreachable("não consegui abrir o app na TV Samsung") from None

    def on_power(self, callback: Callable[[bool], None]) -> None:
        self._power.append(callback)

    def on_app(self, callback: Callable[[str], None]) -> None:
        self._app.append(callback)

    def on_volume(self, callback: Callable[[int], None]) -> None:
        self._volume.append(callback)

    def on_available(self, callback: Callable[[bool], None]) -> None:
        self._available.append(callback)

    def _require_client(self) -> SamsungClient:
        if self._client is None or not self._connected:
            raise TvUnreachable("o canal da TV Samsung não está aberto")
        return self._client

    def _lost(self) -> None:
        if not self._connected:
            return
        self._connected = False
        for callback in self._available:
            callback(False)

    async def _call_client(
        self, operation: Callable[..., Any], *args: Any, wait_seconds: float | None = None
    ) -> Any:
        """Limita a espera pelo cliente síncrono, que pode travar em uma resposta ausente da TV."""
        return await asyncio.wait_for(
            asyncio.to_thread(operation, *args),
            timeout=self._ws_timeout_seconds if wait_seconds is None else wait_seconds,
        )

    async def _probe_app(
        self, client: httpx.AsyncClient, semaphore: asyncio.Semaphore, app_id: str
    ) -> dict[str, str] | None:
        async with semaphore:
            try:
                response = await asyncio.wait_for(
                    client.get(self._application_url(app_id)), timeout=self._app_timeout_seconds
                )
            except httpx.HTTPError, TimeoutError:
                return None
        if response.status_code != httpx.codes.OK:
            return None
        try:
            name = response.json().get("name")
        except ValueError, TypeError:
            return None
        return {"appId": app_id, "name": name} if isinstance(name, str) and name else None

    async def _launch_app_rest(self, app_id: str) -> bool:
        try:
            async with httpx.AsyncClient(transport=self._rest_transport) as client:
                response = await asyncio.wait_for(
                    client.post(self._application_url(app_id)), timeout=self._app_timeout_seconds
                )
        except httpx.HTTPError, TimeoutError:
            return False
        return response.is_success

    def _application_url(self, app_id: str) -> str:
        return f"http://{self._host}:{SAMSUNG_REST_PORT}/api/v2/applications/{app_id}"
