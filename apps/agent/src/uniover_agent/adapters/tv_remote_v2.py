"""Controle da TV pelo Android TV Remote v2 (biblioteca `androidtvremote2` 0.3.2).

O que a biblioteca oferece e o que este adaptador completa (conferido no código instalado):

* `async_connect` espera a TV mandar `remote_start`, **sem limite de tempo**: aqui vai dentro de um
  `wait_for`, senão uma TV que aceita o TLS e não responde trava o agente para sempre;
* a biblioteca só reconecta com `keep_reconnecting`, num laço sem fim (0,1 s até 30 s) que
  disputaria a conexão com o gerenciador de sessão. Não é usado: o gerenciador é o dono da
  conexão e a reconexão dele é limitada;
* depois de uma queda a biblioteca **continua aceitando** `send_key_command` e **descarta a tecla em
  silêncio** (só registra "Connection is closed!"). Por isso o adaptador vigia a queda sozinho e
  recusa o envio com `TvUnreachable` em vez de fingir que apertou;
* as quedas só são sinalizadas pelo laço de `keep_reconnecting`; o adaptador observa o `Future`
  `on_con_lost` do protocolo (atributo interno, por isso o ponto único `_lost_future` e o teste
  contra a biblioteca real de que uma atualização que o mova falhe alto).

Certificado e chave nunca são lidos nem registrados aqui: a biblioteca recebe só os caminhos.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any, Final, Protocol

from androidtvremote2 import (
    AndroidTVRemote,
    CannotConnect,
    ConnectionClosed,
    InvalidAuth,
    VolumeInfo,
)
from androidtvremote2.remotemessage_pb2 import RemoteMessage

from uniover_agent.ports import TextFieldStatus, TvNotPaired, TvPortClosed, TvUnreachable

_log = logging.getLogger(__name__)

CERT_FILE: Final = "cert.pem"
KEY_FILE: Final = "key.pem"
REMOTE_PORT: Final = 6466
# Com a TV em standby (sem rede, não responde nada) cada comando espera 4 tentativas, mais
# 1 + 2 + 4 s; um teto baixo limita esse pior caso (~27 s). A confirmar na medição de religação.
CONNECT_TIMEOUT_SECONDS: Final = 5.0

DIRECTIONS: Final = frozenset({"SHORT", "START_LONG", "END_LONG"})

# Tecla do contrato -> código do Android (`KEYCODE_*`). `POWER` é um interruptor (desliga e, na
# segunda vez, liga): o agente a envia como as demais, mas o gerenciador de sessão não a repete
# logo em seguida (ver `POWER_REPEAT_SECONDS`).
KEY_CODES: Final[Mapping[str, str]] = {
    "POWER": "KEYCODE_POWER",
    "HOME": "KEYCODE_HOME",
    "BACK": "KEYCODE_BACK",
    "UP": "KEYCODE_DPAD_UP",
    "DOWN": "KEYCODE_DPAD_DOWN",
    "LEFT": "KEYCODE_DPAD_LEFT",
    "RIGHT": "KEYCODE_DPAD_RIGHT",
    "OK": "KEYCODE_DPAD_CENTER",
    "VOLUME_UP": "KEYCODE_VOLUME_UP",
    "VOLUME_DOWN": "KEYCODE_VOLUME_DOWN",
    "MUTE": "KEYCODE_VOLUME_MUTE",
    "CHANNEL_UP": "KEYCODE_CHANNEL_UP",
    "CHANNEL_DOWN": "KEYCODE_CHANNEL_DOWN",
    "PLAY_PAUSE": "KEYCODE_MEDIA_PLAY_PAUSE",
    "MENU": "KEYCODE_MENU",
    "MEDIA_NEXT": "KEYCODE_MEDIA_NEXT",
    "MEDIA_PREVIOUS": "KEYCODE_MEDIA_PREVIOUS",
    "INPUT": "KEYCODE_TV_INPUT",
    **{f"NUM_{digit}": f"KEYCODE_{digit}" for digit in range(10)},
}

# Teclas além das básicas que o app pode oferecer como botões extras (a Samsung tem mais).
ANDROID_OPTIONAL_KEYS: Final[tuple[str, ...]] = ("INPUT",)

# Teclas de digitação (`TYPE_*`): letras minúsculas, espaço e pontuação simples, para o agente
# digitar sem passar pelo ADB. Os dígitos usam as teclas `NUM_*` do contrato. São só as teclas
# **sem SHIFT**: a biblioteca aceita `SHIFT_LEFT` com `START_LONG` e `END_LONG`, mas ninguém mediu
# se o serviço da TV aplica o SHIFT à tecla seguinte, então maiúsculas ficam de fora (ver
# `core/tv/text_edit.py`, que decide quais caracteres usam estas teclas).
TYPING_KEY_CODES: Final[Mapping[str, str]] = {
    **{f"TYPE_{letter}": f"KEYCODE_{letter}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    "TYPE_SPACE": "KEYCODE_SPACE",
    "TYPE_PERIOD": "KEYCODE_PERIOD",
    "TYPE_COMMA": "KEYCODE_COMMA",
    "TYPE_MINUS": "KEYCODE_MINUS",
    "TYPE_SLASH": "KEYCODE_SLASH",
}

# Teclas de edição de texto: não fazem parte do contrato de teclas (a API não as envia); só o
# agente as usa, para apagar e digitar o que o dono escreve.
EDIT_KEY_CODES: Final[Mapping[str, str]] = {"DEL": "KEYCODE_DEL", **TYPING_KEY_CODES}


class RemoteClient(Protocol):
    """O pedaço de `AndroidTVRemote` que o adaptador usa (permite um duplo nos testes)."""

    def add_is_on_updated_callback(self, callback: Callable[[bool], None]) -> None: ...

    def add_current_app_updated_callback(self, callback: Callable[[str], None]) -> None: ...

    def add_volume_info_updated_callback(self, callback: Callable[[VolumeInfo], None]) -> None: ...

    async def async_connect(self) -> None: ...

    def disconnect(self) -> None: ...

    def send_key_command(self, key_code: int | str, direction: int | str = ...) -> None: ...

    def send_launch_app_command(self, app_link_or_app_id: str) -> None: ...

    def send_text(self, text: str) -> None: ...


ClientFactory = Callable[[str, str, str, str], RemoteClient]


def _lost_future(client: object) -> asyncio.Future[Any] | None:
    """O `Future` que a biblioteca resolve quando a conexão cai (atributo interno do protocolo)."""
    protocol = getattr(client, "_remote_message_protocol", None)
    future = getattr(protocol, "on_con_lost", None)
    return future if isinstance(future, asyncio.Future) else None


def _text_field_of(message: RemoteMessage) -> TextFieldStatus | None:
    """O estado do campo de texto que a mensagem carrega, ou `None` se ela não traz nenhum.

    `remote_ime_key_inject` também chega só com o app em foco (sem campo): sem o `HasField`, cada
    troca de app pareceria um campo vazio e apagaria o que o agente sabe do texto.
    """
    if message.HasField("remote_ime_key_inject"):
        inject = message.remote_ime_key_inject
        if not inject.HasField("text_field_status"):
            return None
        field = inject.text_field_status
    elif message.HasField("remote_ime_show_request"):
        request = message.remote_ime_show_request
        if not request.HasField("remote_text_field_status"):
            return None
        field = request.remote_text_field_status
    else:
        return None
    return TextFieldStatus(field.value, field.start, field.end, field.label, field.counter_field)


def _install_text_field_hook(client: object, callback: Callable[[TextFieldStatus], None]) -> bool:
    """Lê o estado do campo de texto que a biblioteca recebe da TV, mas não entrega ao chamador.

    Como `_lost_future`, isto depende de um detalhe interno da biblioteca (o tratador de mensagens
    do protocolo da sessão); isolar o acesso aqui faz uma mudança incompatível falhar alto, no
    teste contra a biblioteca real. O tratador original roda primeiro, e o estado do campo é
    entregue em seguida.
    Devolve `False` se o ponto de ligação não existe mais (o agente segue sem o estado do campo).
    """
    protocol: Any = getattr(client, "_remote_message_protocol", None)
    handle = getattr(protocol, "_handle_message", None)
    if not callable(handle):
        return False

    def on_message(raw_message: bytes) -> None:
        field: TextFieldStatus | None = None
        try:
            message = RemoteMessage()
            message.ParseFromString(raw_message)
            field = _text_field_of(message)
        except Exception:
            # Mensagem malformada é problema do tratador original; aqui só não pode derrubá-lo.
            _log.debug("não consegui ler o estado do campo de texto da TV", exc_info=True)
        try:
            handle(raw_message)
        finally:
            # Depois do tratador: a mudança de app que a mesma mensagem traz já foi dada por
            # avisada, e o estado do campo que chega junto é o do app novo.
            if field is not None:
                callback(field)

    try:
        protocol._handle_message = on_message
    except AttributeError, TypeError:
        # Protocolo que não aceita a troca (somente leitura, `__slots__`): segue sem o estado.
        return False
    return True


def volume_percent(info: VolumeInfo) -> int | None:
    """Converte o nível da TV (`level` de `max`) em porcentagem; `None` se `max` não faz sentido."""
    maximum = info["max"]
    if maximum <= 0:
        return None
    return max(0, min(100, round(info["level"] * 100 / maximum)))


class AndroidTvRemoteV2:
    """Implementa `TvRemote` por Android TV Remote v2."""

    def __init__(  # noqa: PLR0913 - parâmetros de sessão e injeções para o teste
        self,
        host: str,
        client_name: str,
        cert_dir: Path,
        *,
        connect_timeout: float = CONNECT_TIMEOUT_SECONDS,
        client_factory: ClientFactory | None = None,
        on_connected: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._host = host
        self._client_name = client_name
        self._certfile = cert_dir / CERT_FILE
        self._keyfile = cert_dir / KEY_FILE
        self._connect_timeout = connect_timeout
        self._factory = client_factory or self._default_factory
        self._on_connected = on_connected
        self._client: RemoteClient | None = None
        self._connected = False
        self._watcher: asyncio.Task[None] | None = None
        self._power: list[Callable[[bool], None]] = []
        self._app: list[Callable[[str], None]] = []
        self._volume: list[Callable[[int], None]] = []
        self._available: list[Callable[[bool], None]] = []
        self._text_field: list[Callable[[TextFieldStatus], None]] = []

    @staticmethod
    def _default_factory(client_name: str, certfile: str, keyfile: str, host: str) -> RemoteClient:
        return AndroidTVRemote(client_name, certfile, keyfile, host, api_port=REMOTE_PORT)

    @property
    def connected(self) -> bool:
        return self._connected

    # --- ciclo de vida ------------------------------------------------------------------------

    async def connect(self) -> None:
        await self.disconnect()
        if not (self._certfile.is_file() and self._keyfile.is_file()):
            raise TvNotPaired("par certificado/chave da TV ausente")
        client = self._client or self._new_client()
        try:
            await asyncio.wait_for(client.async_connect(), self._connect_timeout)
        except InvalidAuth:
            client.disconnect()
            raise TvNotPaired("a TV recusou o certificado (pareamento inválido)") from None
        except CannotConnect as exc:
            client.disconnect()
            if isinstance(exc.__cause__, ConnectionRefusedError):
                # A TV está na rede e fechou a porta: o serviço do controle remoto morreu.
                raise TvPortClosed("a TV recusou a conexão (porta fechada)") from None
            raise TvUnreachable(f"sem resposta da TV ({type(exc.__cause__).__name__})") from None
        except (ConnectionClosed, TimeoutError, OSError) as exc:
            client.disconnect()
            raise TvUnreachable(f"sem resposta da TV ({type(exc).__name__})") from None
        if not _install_text_field_hook(client, self._on_text_field):
            _log.warning("não consegui ligar a leitura do campo de texto da TV; sigo sem ela")
        self._connected = True
        self._watcher = asyncio.get_running_loop().create_task(self._watch_loss(client))
        if self._on_connected is not None:
            try:
                await self._on_connected()
            except Exception:
                _log.exception("falha ao guardar o que se sabe da TV")

    async def disconnect(self) -> None:
        watcher, self._watcher = self._watcher, None
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        self._connected = False
        if self._client is not None:
            self._client.disconnect()

    def _new_client(self) -> RemoteClient:
        client = self._factory(
            self._client_name, str(self._certfile), str(self._keyfile), self._host
        )
        client.add_is_on_updated_callback(lambda is_on: self._fan_out(self._power, is_on))
        client.add_current_app_updated_callback(lambda app: self._fan_out(self._app, app))
        client.add_volume_info_updated_callback(self._on_volume_info)
        self._client = client
        return client

    async def _watch_loss(self, client: RemoteClient) -> None:
        lost = _lost_future(client)
        if lost is None:
            _log.error("não foi possível vigiar a queda da conexão com a TV")
            return
        # `wait` (e não `await lost`): cancelar esta tarefa não pode cancelar o `Future` da lib.
        await asyncio.wait({lost})
        if not self._connected or self._client is not client:
            return
        self._connected = False
        client.disconnect()
        _log.info("conexão com a TV encerrada")
        self._fan_out(self._available, False)

    # --- comandos -----------------------------------------------------------------------------

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        code = KEY_CODES.get(key) or EDIT_KEY_CODES.get(key)
        if code is None:
            # Uma tecla `TYPE_*` desconhecida é um caractere do que o dono digita (pode ser uma
            # senha): a mensagem não a repete.
            hint = "" if key.startswith("TYPE_") else f": {key}"
            raise ValueError(f"tecla desconhecida{hint}")
        if direction not in DIRECTIONS:
            raise ValueError(f"direção desconhecida: {direction}")
        client = self._require()
        try:
            client.send_key_command(code, direction)
        except ConnectionClosed:
            raise TvUnreachable("a conexão com a TV fechou") from None

    async def launch_link(self, link: str) -> None:
        client = self._require()
        try:
            client.send_launch_app_command(link)
        except ConnectionClosed:
            raise TvUnreachable("a conexão com a TV fechou") from None

    async def send_text(self, text: str) -> None:
        # A TV **insere** o trecho no campo em foco (observado: reenviar o campo inteiro duplicava
        # as letras), então quem chama manda só o acréscimo. A biblioteca usa os contadores que a TV
        # empurra a cada edição. Vazio ela recusa com `ValueError`, e o protocolo não oferece outro
        # jeito de limpar o campo (apagar é com `DEL`); por isso aqui também é erro de programação.
        if not text:
            raise ValueError("texto vazio não pode ser enviado à TV")
        client = self._require()
        try:
            client.send_text(text)
        except ConnectionClosed:
            raise TvUnreachable("a conexão com a TV fechou") from None

    def _require(self) -> RemoteClient:
        if not self._connected or self._client is None:
            raise TvUnreachable("a conexão com a TV não está aberta")
        return self._client

    # --- estado empurrado pela TV -------------------------------------------------------------

    def on_power(self, callback: Callable[[bool], None]) -> None:
        self._power.append(callback)

    def on_app(self, callback: Callable[[str], None]) -> None:
        self._app.append(callback)

    def on_volume(self, callback: Callable[[int], None]) -> None:
        self._volume.append(callback)

    def on_available(self, callback: Callable[[bool], None]) -> None:
        self._available.append(callback)

    def on_text_field(self, callback: Callable[[TextFieldStatus], None]) -> None:
        self._text_field.append(callback)

    def _on_volume_info(self, info: VolumeInfo) -> None:
        percent = volume_percent(info)
        if percent is not None:
            self._fan_out(self._volume, percent)

    def _on_text_field(self, field: TextFieldStatus) -> None:
        self._fan_out(self._text_field, field)

    @staticmethod
    def _fan_out[T](callbacks: list[Callable[[T], None]], value: T) -> None:
        for callback in callbacks:
            # Um ouvinte com defeito não pode calar os outros nem a leitura da TV.
            try:
                callback(value)
            except Exception:
                _log.exception("falha em um ouvinte do estado da TV")
