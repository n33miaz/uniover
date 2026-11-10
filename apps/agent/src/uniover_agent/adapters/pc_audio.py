"""Volume absoluto do PC no Windows: Core Audio (`IAudioEndpointVolume`) por `ctypes`.

Nenhuma biblioteca a mais: o agente chama a tabela virtual dos objetos COM direto (o `comtypes` não
é dependência dele). A conta é só esta: criar o enumerador de dispositivos, pedir o dispositivo de
saída padrão, ativar o controle de volume dele, ler ou definir o volume principal e liberar tudo. O
dispositivo é pedido a cada chamada (nada fica guardado), então trocar a saída padrão do Windows
vale na hora; uma chamada custa poucos milissegundos e só ocorre quando alguém muda o volume ou na
leitura periódica.

O abrir e o fechar do dispositivo ficam atrás de `EndpointOpener`: os testes entregam um dispositivo
de mentira e nunca tocam no áudio de verdade. Fora do Windows tudo recusa com `PcUnsupported`.
"""

import logging
import sys
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Final, Protocol

from uniover_agent.ports.pc import PcUnsupported, VolumeState

_log = logging.getLogger(__name__)

_UNSUPPORTED: Final = "o volume do PC só existe no Windows"
MIN_LEVEL: Final = 0
MAX_LEVEL: Final = 100

# Identificadores do Core Audio (`mmdeviceapi.h` e `endpointvolume.h`).
_CLSID_MM_DEVICE_ENUMERATOR: Final = "BCDE0395-E52F-467C-8E3D-C4579291692E"
_IID_IMM_DEVICE_ENUMERATOR: Final = "A95664D2-9614-4F35-A746-DE8DB63617E6"
_IID_IAUDIO_ENDPOINT_VOLUME: Final = "5CDF2C82-841E-4546-9722-0CF74078229A"

# Posição de cada método na tabela virtual (0 a 2 são os do `IUnknown`: QueryInterface, AddRef e
# Release). Um índice errado chamaria outro método: estão conferidos contra os cabeçalhos.
_RELEASE: Final = 2
_ENUMERATOR_GET_DEFAULT_AUDIO_ENDPOINT: Final = 4
_DEVICE_ACTIVATE: Final = 3
_VOLUME_SET_MASTER_VOLUME_LEVEL_SCALAR: Final = 7
_VOLUME_GET_MASTER_VOLUME_LEVEL_SCALAR: Final = 9
_VOLUME_SET_MUTE: Final = 14
_VOLUME_GET_MUTE: Final = 15

_E_RENDER: Final = 0  # EDataFlow: a saída (alto-falantes e fones)
_E_MULTIMEDIA: Final = 1  # ERole: o dispositivo padrão para música e vídeo
_CLSCTX_ALL: Final = 0x17
_COINIT_MULTITHREADED: Final = 0
_S_OK: Final = 0
_S_FALSE: Final = 1
_RPC_E_CHANGED_MODE: Final = -2147417850  # 0x80010106: a thread já usa COM de outro jeito; serve


class Endpoint(Protocol):
    """O controle de volume do dispositivo de saída padrão, aberto por uma chamada."""

    def get_scalar(self) -> float:
        """O volume principal como fração (0.0 a 1.0)."""
        ...

    def set_scalar(self, value: float) -> None: ...

    def get_mute(self) -> bool: ...

    def set_mute(self, muted: bool) -> None: ...


EndpointOpener = Callable[[], AbstractContextManager[Endpoint]]


def to_percent(scalar: float) -> int:
    """A fração do Windows como porcentagem inteira (0 a 100)."""
    return max(MIN_LEVEL, min(MAX_LEVEL, round(scalar * 100)))


class WindowsPcAudio:
    """O volume do PC: ler o nível e o mudo, definir o nível, ligar e desligar o mudo.

    `open_endpoint` é trocável para os testes. Nada é aberto ao construir: a primeira chamada abre.
    """

    def __init__(self, open_endpoint: EndpointOpener | None = None) -> None:
        self._open = open_endpoint or _open_core_audio

    def read(self) -> VolumeState:
        with self._open() as endpoint:
            return VolumeState(to_percent(endpoint.get_scalar()), endpoint.get_mute())

    def set_level(self, level: int) -> None:
        # O contrato já limita; isto protege o sistema de um erro nosso.
        if isinstance(level, bool) or not MIN_LEVEL <= level <= MAX_LEVEL:
            raise ValueError("nível de volume fora de 0 a 100")
        with self._open() as endpoint:
            endpoint.set_scalar(level / 100)

    def set_muted(self, muted: bool) -> None:
        with self._open() as endpoint:
            endpoint.set_mute(muted)


if sys.platform == "win32":
    import ctypes
    from ctypes import byref, c_int, c_int32, c_ubyte, c_uint32, c_ulong, c_void_p

    def _guid(text: str) -> ctypes.Array[c_ubyte]:
        """O GUID na ordem de bytes do Windows (os três primeiros campos em little-endian)."""
        return (c_ubyte * 16).from_buffer_copy(uuid.UUID(text).bytes_le)

    class _Com:
        """Um ponteiro de interface COM: chama métodos pela posição na tabela virtual."""

        def __init__(self, pointer: c_void_p) -> None:
            if not pointer.value:
                raise OSError("o Windows não entregou a interface de áudio")
            self._pointer = pointer

        def _method(self, index: int) -> int:
            table = c_void_p.from_address(self._pointer.value or 0).value or 0
            address = c_void_p.from_address(table + index * ctypes.sizeof(c_void_p)).value
            if not address:
                raise OSError("a interface de áudio não tem o método pedido")
            return address

        def call(self, index: int, argtypes: tuple[type, ...], *args: object) -> None:
            """Chama o método `index` com `args`; um HRESULT de falha vira `OSError`."""
            # O retorno é lido como número e conferido aqui, não deixado a cargo do `ctypes`: uma
            # falha (bit alto ligado) nunca pode passar por sucesso nem devolver um buffer zerado.
            prototype = ctypes.WINFUNCTYPE(c_int32, c_void_p, *argtypes)
            result = int(prototype(self._method(index))(self._pointer, *args))
            if result < 0:
                raise OSError(
                    f"o Windows recusou a chamada de áudio (HRESULT {result & 0xFFFFFFFF:#010x})"
                )

        def release(self) -> None:
            prototype = ctypes.WINFUNCTYPE(c_ulong, c_void_p)
            prototype(self._method(_RELEASE))(self._pointer)

    class _CoreEndpoint:
        """`IAudioEndpointVolume` por cima da tabela virtual."""

        def __init__(self, volume: _Com) -> None:
            self._volume = volume

        def get_scalar(self) -> float:
            value = ctypes.c_float()
            self._volume.call(_VOLUME_GET_MASTER_VOLUME_LEVEL_SCALAR, (c_void_p,), byref(value))
            return float(value.value)

        def set_scalar(self, value: float) -> None:
            # O segundo argumento é o contexto do evento (nulo: não há quem filtre a notificação).
            self._volume.call(
                _VOLUME_SET_MASTER_VOLUME_LEVEL_SCALAR,
                (ctypes.c_float, c_void_p),
                ctypes.c_float(value),
                None,
            )

        def get_mute(self) -> bool:
            value = c_int()
            self._volume.call(_VOLUME_GET_MUTE, (c_void_p,), byref(value))
            return bool(value.value)

        def set_mute(self, muted: bool) -> None:
            self._volume.call(_VOLUME_SET_MUTE, (c_int, c_void_p), c_int(1 if muted else 0), None)

    def _co_initialize() -> bool:
        """Prepara COM nesta thread. `True` se é preciso desfazer depois (`CoUninitialize`)."""
        result = int(ctypes.windll.ole32.CoInitializeEx(None, _COINIT_MULTITHREADED))
        if result in (_S_OK, _S_FALSE):
            return True
        if result == _RPC_E_CHANGED_MODE:
            return (
                False  # a thread já tem COM, de outro modelo: dá para usar e não é nosso desfazer
            )
        raise OSError(f"o Windows não preparou o COM (código {result & 0xFFFFFFFF:#x})")

    @contextmanager
    def _open_core_audio() -> Iterator[Endpoint]:
        initialized = _co_initialize()
        held: list[_Com] = []
        try:
            created = c_void_p()
            ctypes.oledll.ole32.CoCreateInstance(
                byref(_guid(_CLSID_MM_DEVICE_ENUMERATOR)),
                None,
                _CLSCTX_ALL,
                byref(_guid(_IID_IMM_DEVICE_ENUMERATOR)),
                byref(created),
            )
            enumerator = _Com(created)
            held.append(enumerator)
            device_pointer = c_void_p()
            enumerator.call(
                _ENUMERATOR_GET_DEFAULT_AUDIO_ENDPOINT,
                (c_int, c_int, c_void_p),
                _E_RENDER,
                _E_MULTIMEDIA,
                byref(device_pointer),
            )
            device = _Com(device_pointer)
            held.append(device)
            volume_pointer = c_void_p()
            device.call(
                _DEVICE_ACTIVATE,
                (c_void_p, c_uint32, c_void_p, c_void_p),
                byref(_guid(_IID_IAUDIO_ENDPOINT_VOLUME)),
                _CLSCTX_ALL,
                None,
                byref(volume_pointer),
            )
            volume = _Com(volume_pointer)
            held.append(volume)
            yield _CoreEndpoint(volume)
        finally:
            for pointer in reversed(held):
                try:
                    pointer.release()
                except OSError:
                    _log.debug("não consegui liberar uma interface de áudio", exc_info=True)
            if initialized:
                ctypes.windll.ole32.CoUninitialize()

else:

    @contextmanager
    def _open_core_audio() -> Iterator[Endpoint]:
        raise PcUnsupported(_UNSUPPORTED)
        yield  # pragma: no cover - o `yield` faz disto um gerenciador de contexto
