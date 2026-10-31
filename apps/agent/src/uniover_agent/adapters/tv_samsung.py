"""Controle Samsung Tizen pelo WebSocket local e estado de energia pelo REST.

`samsungtvws` é síncrona; cada chamada fica numa thread para nunca parar o recebimento de comandos
da API. O token entra direto no cliente, pois a biblioteca só precisa do arquivo quando não recebe
o token explicitamente.
"""

import asyncio
import logging
import ssl
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx
import websocket
from samsungtvws import SamsungTVWS
from samsungtvws import exceptions as samsung_exceptions
from samsungtvws import helper as samsung_helper
from samsungtvws.event import (
    IGNORE_EVENTS_AT_STARTUP,
    MS_CHANNEL_CONNECT_EVENT,
    MS_CHANNEL_UNAUTHORIZED,
)

from uniover_agent.adapters.tv_discovery import samsung_identity
from uniover_agent.adapters.tv_samsung_volume import SamsungVolume
from uniover_agent.core.tv.locator import TvIdentity
from uniover_agent.ports import TvNotPaired, TvPermissionNeeded, TvUnreachable

_log = logging.getLogger(__name__)

SAMSUNG_PORT = 8002
# O nome com que o UniOver se apresenta à TV. A TV liga o token (e o "Permitir" que a pessoa deu) a
# este nome: mudá-lo, ou deixá-lo depender de configuração, faria a TV perguntar tudo de novo. O
# valor é o mesmo que sempre foi o padrão e não pode mudar.
SAMSUNG_CLIENT_NAME = "UniOver"
# Quanto o aviso "Permitir" fica à espera de alguém na frente da TV.
SAMSUNG_PERMISSION_TIMEOUT_SECONDS = 60.0
# Evento com que a TV desiste do aviso que ninguém respondeu.
MS_CHANNEL_TIMEOUT = "ms.channel.timeOut"
SAMSUNG_REST_PORT = 8001
SAMSUNG_TIMEOUT_SECONDS = 5.0
SAMSUNG_APP_TIMEOUT_SECONDS = 3.0
SAMSUNG_APP_LIST_TIMEOUT_SECONDS = 5.0
SAMSUNG_APP_ICON_TIMEOUT_SECONDS = 1.0
SAMSUNG_APP_PROBE_CONCURRENCY = 8
# Ícones seguidos sem resposta que encerram o pedido de ícones (a TV está sem fôlego).
SAMSUNG_ICON_MAX_FAILURES = 3
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
    "GUIDE": "KEY_GUIDE",
    "TOOLS": "KEY_TOOLS",
    "CHANNEL_LIST": "KEY_CH_LIST",
    "PREVIOUS_CHANNEL": "KEY_PRECH",
    "EXIT": "KEY_EXIT",
    "RED": "KEY_RED",
    "GREEN": "KEY_GREEN",
    "YELLOW": "KEY_YELLOW",
    # No controle Samsung a tecla azul se chama CYAN.
    "BLUE": "KEY_CYAN",
    "SUBTITLE": "KEY_CAPTION",
    "ASPECT": "KEY_PICTURE_SIZE",
    "SLEEP": "KEY_SLEEP",
    "E_MANUAL": "KEY_EMANUAL",
    **{f"NUM_{number}": f"KEY_{number}" for number in range(10)},
}


# Teclas além das básicas que o app oferece como botões extras (o agente declara as que a TV tem).
SAMSUNG_OPTIONAL_KEYS: tuple[str, ...] = (
    "INPUT",
    "INFO",
    "GUIDE",
    "TOOLS",
    "CHANNEL_LIST",
    "PREVIOUS_CHANNEL",
    "EXIT",
    "PLAY",
    "PAUSE",
    "STOP",
    "REWIND",
    "FAST_FORWARD",
    "RED",
    "GREEN",
    "YELLOW",
    "BLUE",
    "SUBTITLE",
    "ASPECT",
    "SLEEP",
    "E_MANUAL",
)


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
# Pede a permissão à TV (com o token guardado, se houver) e devolve o token que ela entregou.
TokenRequester = Callable[[str | None], Awaitable[str]]


class SamsungAwaitingPermission(Exception):  # noqa: N818
    """A TV atendeu o WebSocket mas não concluiu a conexão: espera alguém aceitar o aviso.

    Sem esta distinção a espera do aviso é indistinguível de uma TV lenta (as duas estouram o tempo
    do soquete), e a abertura seguinte faria a TV mostrar o aviso outra vez.
    """


def is_permission_failure(exc: BaseException) -> bool:
    """A TV recusou ou deixou pendente a permissão do UniOver (e não: está fora do ar ou lenta)."""
    if isinstance(exc, SamsungAwaitingPermission | samsung_exceptions.UnauthorizedError):
        return True
    if isinstance(exc, samsung_exceptions.ConnectionFailure):
        payload = exc.args[0] if exc.args else None
        return isinstance(payload, dict) and payload.get("event") == MS_CHANNEL_TIMEOUT
    return False


class _SamsungTvWs(SamsungTVWS):
    """Extensão da biblioteca: o evento EDEN de ícones e a abertura que separa o aviso pendente."""

    def open(self) -> websocket.WebSocket:
        """Igual à da biblioteca (2.7.2), mas o tempo esgotado **depois** do aperto de mão do
        WebSocket vira `SamsungAwaitingPermission`: a TV está viva e espera o aceite."""
        if self.connection:
            return self.connection
        url = self._format_websocket_url(self.endpoint)
        sslopt = {"cert_reqs": ssl.CERT_NONE} if self._is_ssl_connection() else {}
        connection = websocket.create_connection(
            url, self.timeout, sslopt=sslopt, connection="Connection: Upgrade"
        )
        try:
            event: str | None = None
            response: dict[str, Any] = {}
            while event is None or event in IGNORE_EVENTS_AT_STARTUP:
                try:
                    data = connection.recv()
                except websocket.WebSocketTimeoutException:
                    raise SamsungAwaitingPermission from None
                response = samsung_helper.process_api_response(data)
                event = response.get("event", "*")
                self._websocket_event(event, response)
            if event == MS_CHANNEL_UNAUTHORIZED:
                raise samsung_exceptions.UnauthorizedError(response)
            if event != MS_CHANNEL_CONNECT_EVENT:
                raise samsung_exceptions.ConnectionFailure(response)
            self._check_for_token(response)
        except BaseException:
            connection.close()
            raise
        self.connection = connection
        return connection

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
        volume: SamsungVolume | None = None,
        on_identity: IdentitySink | None = None,
        save_token: Callable[[str], None] | None = None,
        permission_needed: bool = False,
        request_token: TokenRequester | None = None,
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
        self._upnp = volume or SamsungVolume(host, transport=rest_transport)
        self._on_identity = on_identity
        self._save_token = save_token
        self._permission_needed = permission_needed
        self._request_token = request_token
        self._permission_lock = asyncio.Lock()
        self._permission: list[Callable[[bool], None]] = []
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

    @property
    def permission_needed(self) -> bool:
        """A TV não reconhece mais o UniOver: nenhuma conexão é tentada até um pedido explícito."""
        return self._permission_needed

    def on_permission(self, callback: Callable[[bool], None]) -> None:
        """Avisa quando a permissão passa a ser necessária (`True`) ou volta a valer (`False`)."""
        self._permission.append(callback)

    def _set_permission_needed(self, needed: bool) -> None:
        if self._permission_needed == needed:
            return
        self._permission_needed = needed
        for callback in self._permission:
            try:
                callback(needed)
            except Exception:
                _log.exception("falha no aviso de permissão da TV Samsung")

    async def reachable(self) -> bool:
        """A TV responde ao REST? Leitura passiva, que nunca dispara o aviso de permissão."""
        return await fetch_samsung_info(self._host) is not None

    async def request_permission(self) -> bool:
        """Pede o aviso "Permitir" na TV e espera o aceite; `True` se a TV o concedeu.

        É o único caminho que fala com a TV enquanto a permissão é necessária, e só roda quando a
        pessoa pede. Com o token guardado, uma TV que ainda o reconhece conecta na hora e nada
        aparece na tela. O token novo, se houver, vai para o cofre.
        """
        if self._request_token is None:
            return False
        async with self._permission_lock:
            await self.disconnect()
            try:
                token = await self._request_token(self._token)
            except Exception:
                return False
            if token != self._token:
                self._token = token
                if self._save_token is not None:
                    self._save_token(token)
            self._set_permission_needed(False)
            return True

    async def connect(self) -> None:
        if self._connected:
            return
        if self._permission_needed:
            # Sem tocar na rede: cada tentativa faria a TV mostrar o aviso sem ninguém ter pedido.
            raise TvPermissionNeeded("a TV Samsung pediu a permissão do UniOver de novo")
        if not self._token:
            raise TvNotPaired("a TV Samsung ainda não foi pareada")
        client = self._factory(self._host, self._token, self._name)
        try:
            # Um pouco além do tempo do soquete: o aviso pendente precisa chegar como tal (e não
            # como um tempo esgotado daqui) para a TV não ser incomodada outra vez.
            await self._call_client(client.open, wait_seconds=self._ws_timeout_seconds * 1.2)
        except Exception as exc:
            if is_permission_failure(exc):
                self._set_permission_needed(True)
                raise TvPermissionNeeded(
                    "a TV Samsung pediu a permissão do UniOver de novo"
                ) from None
            # Antes a causa se perdia aqui: token recusado e TV fora do ar viravam a mesma frase. O
            # tipo da exceção e o aviso de recusa (a TV responde, mas não aceita o token) vão para o
            # registro.
            refused = "unauthorized" in str(exc).lower() or "token" in str(exc).lower()
            _log.warning(
                "a TV Samsung não abriu o controle remoto (%s)%s",
                type(exc).__name__,
                "; parece que ela recusou o token" if refused else "",
            )
            raise TvUnreachable("a TV Samsung não respondeu ao controle remoto") from None
        self._client = client
        self._connected = True
        # A TV pode renovar o token no aceite do canal; guardar a versão nova evita novo aviso.
        if client.token and client.token != self._token:
            self._token = client.token
            if self._save_token is not None:
                self._save_token(client.token)
        # A TV pode ter mudado de endereço de serviço desde a conexão anterior: descobre de novo.
        self._upnp.reset()
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

    async def read_power(self) -> bool | None:
        """Energia agora, pelo REST da TV (não o valor lido ao abrir a sessão, que pode ser velho).

        `PowerState` `standby` conta como desligada; sem resposta devolve `None`.
        """
        if self._fetch_power is not None:
            return await self._fetch_power(self._host)
        return power_from_info(await fetch_samsung_info(self._host))

    async def read_volume(self) -> int | None:
        """Volume atual pelo serviço UPnP que a própria TV descreve; `None` se ela não o tem.

        Só é chamado ao abrir a sessão e logo depois de uma tecla de volume: não há sondagem.
        """
        return await self._upnp.read()

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
