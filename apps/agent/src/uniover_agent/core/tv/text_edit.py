"""Digitação confiável: em vez de reenviar o campo inteiro, só aplica a diferença.

O app manda o texto completo a cada pausa de digitação. O controle remoto (Remote v2) **insere** o
que recebe no campo da TV, então reenviar o texto inteiro duplicava letras, e apagar não existia.
Aqui o agente guarda o que ele mesmo digitou (`last_text`) e a cada mensagem:

1. calcula o prefixo que o texto novo tem em comum com o anterior;
2. apaga o excedente com `DEL` (teclas curtas, uma a uma);
3. digita só o acréscimo.

O acréscimo vai por **um** canal só, para a ordem dos caracteres não depender de dois caminhos com
latências diferentes: pelo ADB (`input text`) quando é ASCII imprimível e o canal está pronto, senão
pelo Remote v2 (acentos, emoji e `%` o ADB não escreve com fidelidade).

`last_text` acompanha o que de fato aconteceu, passo a passo: uma falha no meio nunca faz o agente
acreditar que o campo tem o que ele não conseguiu escrever (senão o diff seguinte apagaria texto do
dono).
"""

import asyncio
import logging
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError, AdbNotReady, is_adb_typable

_log = logging.getLogger(__name__)

# Sem digitação por este tempo, o campo em foco pode já não ser o mesmo. Só vira campo novo se o
# texto também mudou por completo (não é continuação nem apagar parcial): ver `_field_changed`.
FIELD_IDLE_SECONDS: Final = 20.0
# Teto de teclas `DEL` por mensagem (o texto tem no máximo 200 caracteres).
MAX_DELETIONS: Final = 200
DELETE_KEY: Final = "DEL"


class TextControl(Protocol):
    """O que a digitação pede à sessão da TV (o `TvSessionManager` implementa)."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def wake(self) -> None: ...


class AdbTyping(Protocol):
    """O pedaço do canal ADB que digita (o adaptador implementa `TvAdb`)."""

    async def input_text(self, text: str) -> None: ...


@dataclass(frozen=True, slots=True)
class TextEdit:
    """O que fazer no campo: apagar `delete` caracteres do fim e digitar `insert`."""

    delete: int
    insert: str


def plan_edit(old: str, new: str) -> TextEdit:
    """Diferença mínima entre o que o agente digitou (`old`) e o que o dono quer (`new`)."""
    common = 0
    for before, after in zip(old, new, strict=False):
        if before != after:
            break
        common += 1
    return TextEdit(len(old) - common, new[common:])


class TextReconciler:
    """Leva o campo em foco da TV até o texto pedido, aplicando só a diferença."""

    def __init__(
        self,
        tv: TextControl,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        field_idle_seconds: float = FIELD_IDLE_SECONDS,
    ) -> None:
        self._tv = tv
        self._monotonic = monotonic
        self._idle = field_idle_seconds
        self._adb: AdbTyping | None = None
        self._last = ""
        self._last_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def last_text(self) -> str:
        """O que o agente acredita ter no campo (o que ele mesmo digitou)."""
        return self._last

    def use_adb(self, adb: AdbTyping) -> None:
        """Passa a digitar pelo ADB o que ele escreve com fidelidade (a composição liga isto)."""
        self._adb = adb

    async def set_text(self, text: str) -> None:
        """Faz o campo ter `text`. Levanta `TvSessionError` se a TV não pôde ser alcançada.

        As chamadas entram uma por vez, na ordem; vazio apaga tudo o que o agente digitou.
        """
        target = unicodedata.normalize("NFC", text)
        async with self._lock:
            now = self._monotonic()
            if self._field_changed(now, target):
                self._last = ""
            edit = plan_edit(self._last, target)
            if edit.delete == 0 and not edit.insert:
                self._last_at = now
                return
            # Abre a sessão (e renova a hibernação) uma vez, antes de qualquer tecla.
            await self._tv.wake()
            await self._apply(edit)
            self._last_at = self._monotonic()

    def _field_changed(self, now: float, target: str) -> bool:
        """Passou tempo demais **e** o texto novo não continua nem encurta o que foi digitado.

        Continuação ("mat" -> "matrix") ou apagar parcial ("matrix" -> "mat") é o mesmo campo,
        qualquer que seja a pausa: tratar como campo novo duplicaria ("matmatrix"). Só uma troca
        radical depois de uma pausa longa indica outro campo, e então nada é apagado.
        """
        if self._last_at is None:
            return True
        if now - self._last_at <= self._idle:
            return False
        return not (target.startswith(self._last) or self._last.startswith(target))

    async def _apply(self, edit: TextEdit) -> None:
        # O relógio do campo anda a cada passo que deu certo: uma falha no meio não o "esfria".
        for _ in range(min(edit.delete, MAX_DELETIONS)):
            await self._tv.send_key(DELETE_KEY)
            self._last = self._last[:-1]
            self._last_at = self._monotonic()
        if edit.insert:
            await self._type(edit.insert)
            self._last += edit.insert
            self._last_at = self._monotonic()

    async def _type(self, text: str) -> None:
        adb = self._adb
        if adb is not None and is_adb_typable(text):
            try:
                await adb.input_text(text)
            except AdbNotReady as exc:
                # Nada foi executado na TV: o Remote v2 digita o mesmo texto sem repetir efeito.
                _log.info("ADB indisponível para digitar (%s); usando o controle remoto", exc.code)
            except AdbError as exc:
                raise TvSessionError(exc.code, exc.message) from None
            else:
                return
        await self._tv.send_text(text)
