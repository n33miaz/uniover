"""Digitação confiável: em vez de reenviar o campo inteiro, só aplica a diferença.

O app manda o texto completo a cada pausa de digitação. O controle remoto (Remote v2) **insere** o
que recebe no campo da TV, então reenviar o texto inteiro duplicava letras, e apagar não existia.
Aqui o agente guarda o que ele mesmo digitou (`last_text`) e a cada mensagem:

1. calcula o prefixo que o texto novo tem em comum com o anterior;
2. apaga o excedente com `DEL` (teclas curtas, uma a uma);
3. digita só o acréscimo.

O acréscimo vai por **um** canal só, para a ordem dos caracteres não depender de dois caminhos com
latências diferentes. Do mais rápido para o mais lento:

* **teclas do controle remoto** (opcional, `keys=True`): cada caractere é um pacote no mesmo fluxo
  do `DEL`, sem processo novo. Só vale quando **todos** os caracteres do acréscimo têm tecla sem
  ambiguidade (ver `TYPING_KEYS`); senão o acréscimo inteiro segue pelos canais abaixo, nunca
  dividido entre canais. Por quê: teclas e `send_text` chegam à TV por caminhos diferentes (o
  `send_text` usa contadores que a própria TV empurra a cada edição do campo), então um trecho
  enviado logo depois de teclas poderia chegar fora de ordem ou com contadores velhos, e o `await`
  não prova entrega (a biblioteca só enfileira no mesmo socket). Dentro do mesmo fluxo de teclas (o
  `DEL` e as letras) a ordem é a do socket;
* **ADB** (`input text`) quando é ASCII imprimível e o canal está pronto: um processo `adb` por
  trecho, e no Android TV o `input text` sobe uma JVM a cada chamada;
* **Remote v2** (`send_text`) para o resto (acentos, emoji, `%`, e quando o ADB não está pronto).

Quando a TV informa o estado do campo em foco (valor, cursor, rótulo), `last_text` parte do valor
real em vez do palpite, e a troca de campo vem por esse aviso, não pela pausa de 20 s (ver
`observe_field`). Sem esse aviso, o comportamento é exatamente o descrito acima.

`last_text` acompanha o que de fato aconteceu, passo a passo: uma falha no meio nunca faz o agente
acreditar que o campo tem o que ele não conseguiu escrever (senão o diff seguinte apagaria texto do
dono).

Cada comando deixa **uma** linha de resumo no log (tamanhos, canal e duração de cada fase), sem o
texto: o que se digita pode ser uma senha.
"""

import asyncio
import logging
import string
import time
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Final, Protocol

from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AdbError, AdbNotReady, TextFieldStatus, is_adb_typable

_log = logging.getLogger(__name__)

# Sem digitação por este tempo, o campo em foco pode já não ser o mesmo. Só vira campo novo se o
# texto também mudou por completo (não é continuação nem apagar parcial): ver `_field_changed`.
FIELD_IDLE_SECONDS: Final = 20.0
# Teto de teclas `DEL` por mensagem (o texto tem no máximo 200 caracteres).
MAX_DELETIONS: Final = 200
DELETE_KEY: Final = "DEL"
TEXT_KEY_UNSUPPORTED: Final = "text_key_unsupported"

# Caractere -> tecla do controle (`KEYCODE_*` do Android, escolhido pelo adaptador). Só entram os
# caracteres que a tecla **sozinha** (sem SHIFT) produz em qualquer mapa de teclas do Android:
# a-z minúsculas, 0-9, espaço e `.` `,` `-` `/`. Ficam de fora, e seguem pelo canal de sempre:
#
# * maiúsculas e `_`: precisam de SHIFT. A biblioteca até aceita `SHIFT_LEFT` com `START_LONG` e
#   `END_LONG`, mas se o serviço da TV aplica o SHIFT na tecla seguinte ninguém mediu; não se
#   inventa (sairia minúscula, ou o SHIFT ficaria preso);
# * `@` e os demais símbolos: o caractere depende do mapa de teclas da TV, que não dá para conferir
#   daqui. Entram quando a medição na TV real provar.
TYPING_KEYS: Final[Mapping[str, str]] = {
    **{letter: f"TYPE_{letter.upper()}" for letter in string.ascii_lowercase},
    **{str(digit): f"NUM_{digit}" for digit in range(10)},
    " ": "TYPE_SPACE",
    ".": "TYPE_PERIOD",
    ",": "TYPE_COMMA",
    "-": "TYPE_MINUS",
    "/": "TYPE_SLASH",
}

CHANNEL_NONE: Final = "nenhum"
CHANNEL_KEYS: Final = "teclas"
CHANNEL_ADB: Final = "adb"
CHANNEL_REMOTE: Final = "remote"


class TextControl(Protocol):
    """O que a digitação pede à sessão da TV (o `TvSessionManager` implementa)."""

    async def send_key(self, key: str, direction: str = "SHORT") -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def wake(self) -> None: ...


class AdbTyping(Protocol):
    """O pedaço do canal ADB que digita (o adaptador implementa `TvAdb`).

    Se o adaptador também expõe `last_input_wait_seconds` (quanto o último `input_text` esperou a
    trava do ADB, que os comandos de apps compartilham), o valor entra no resumo do log.
    """

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


def typing_keys(text: str) -> list[str] | None:
    """Uma tecla por caractere, ou `None` se algum não tem tecla segura (ou se o texto é vazio)."""
    if not text:
        return None
    keys: list[str] = []
    for char in text:
        key = TYPING_KEYS.get(char)
        if key is None:
            return None
        keys.append(key)
    return keys


@dataclass(slots=True)
class _Trace:
    """O que um comando de texto fez e quanto cada fase levou. Nunca guarda o texto."""

    queued: float
    previous: int = 0
    delete: int = 0
    insert: int = 0
    channel: str = CHANNEL_NONE
    adb_unavailable: str | None = None
    adb_wait: float | None = None
    outcome: str = "ok"
    lock_wait: float = 0.0
    wake: float = 0.0
    erase: float = 0.0
    typing: float = 0.0
    total: float = 0.0

    def line(self) -> str:
        def ms(seconds: float) -> int:
            return round(seconds * 1000)

        adb = "-" if self.adb_wait is None else str(ms(self.adb_wait))
        fallback = f" adb_indisponivel={self.adb_unavailable}" if self.adb_unavailable else ""
        return (
            f"texto anterior={self.previous} apagar={self.delete} inserir={self.insert} "
            f"canal={self.channel}{fallback} resultado={self.outcome} | ms "
            f"vez={ms(self.queued + self.lock_wait)} adb={adb} wake={ms(self.wake)} "
            f"apagar={ms(self.erase)} digitar={ms(self.typing)} total={ms(self.total)}"
        )


class TextReconciler:
    """Leva o campo em foco da TV até o texto pedido, aplicando só a diferença."""

    def __init__(  # noqa: PLR0913 - todas são ajustes independentes, com padrão seguro
        self,
        tv: TextControl,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        field_idle_seconds: float = FIELD_IDLE_SECONDS,
        keys: bool = False,
        key_pause_seconds: float = 0.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._tv = tv
        self._monotonic = monotonic
        self._idle = field_idle_seconds
        self._keys = keys
        self._key_pause = key_pause_seconds
        self._sleep = sleep
        self._adb: AdbTyping | None = None
        self._last = ""
        self._last_at: float | None = None
        self._field_counter: int | None = None
        self._pending_field: TextFieldStatus | None = None
        self._app: str | None = None
        self._lock = asyncio.Lock()

    @property
    def last_text(self) -> str:
        """O que o agente acredita ter no campo (o que ele mesmo digitou)."""
        return self._last

    @property
    def keys_enabled(self) -> bool:
        """Se o acréscimo com só caracteres mapeados vai por teclas do controle."""
        return self._keys

    def use_adb(self, adb: AdbTyping) -> None:
        """Passa a digitar pelo ADB o que ele escreve com fidelidade (a composição liga isto)."""
        self._adb = adb

    def observe_field(self, field: TextFieldStatus) -> None:
        """Sincroniza a base do diff com o que a TV informou do campo em foco.

        Com o estado em mãos, `last_text` deixa de ser palpite: é o valor real do campo, e uma troca
        de campo chega por um contador novo em vez de depender da pausa desde a última digitação
        (`_field_changed`). Sem nenhum aviso da TV, tudo segue como antes.

        A TV ecoa cada edição, e o eco de um passo antigo pode chegar depois de a edição acabar:
        reescrever `last_text` com ele faria o diff seguinte repetir ou apagar texto. Por isso só
        o contador diferente (outro campo) troca a base; com o mesmo contador, o que o agente
        acabou de fazer, passo a passo, segue sendo a fonte mais fiel. Pelo mesmo motivo, nada é
        lido enquanto uma edição nossa está em andamento, e o primeiro aviso, se o agente já
        digitou antes de recebê-lo, só registra o contador (o valor pode ser um passo
        intermediário).

        Um estado de outro campo (contador diferente) que chega no meio de uma edição não se
        perde: fica guardado e entra assim que ela termina. Descartá-lo deixaria o contador antigo
        valendo para o campo novo, e o comando seguinte apagaria o texto do campo anterior.
        """
        if self._lock.locked():
            if field.counter != self._field_counter:
                self._pending_field = field
            return
        self._accept(field)

    def forget_field(self) -> None:
        """Esquece o estado do campo: nova sessão com a TV ou outro app em foco.

        Sem estado fresco do campo atual volta o comportamento conservador de antes: a base é o
        que o agente digitou e a pausa de `field_idle_seconds` decide se o campo é outro. Nunca se
        apaga com base em estado velho.
        """
        self._field_counter = None
        self._pending_field = None

    def observe_app(self, app: str) -> None:
        """O app em foco mudou? Então o estado do campo era de outro lugar.

        A TV repete o app a cada eco de edição; só a troca de verdade esquece o estado.
        """
        previous, self._app = self._app, app
        if previous is not None and previous != app:
            self.forget_field()

    def _accept(self, field: TextFieldStatus) -> None:
        previous, self._field_counter = self._field_counter, field.counter
        if previous == field.counter:
            return
        if previous is None and self._last_at is not None:
            return
        self._last = unicodedata.normalize("NFC", field.value)
        self._last_at = self._monotonic()

    async def set_text(self, text: str, *, queued: float = 0.0) -> None:
        """Faz o campo ter `text`. Levanta `TvSessionError` se a TV não pôde ser alcançada.

        As chamadas entram uma por vez, na ordem; vazio apaga tudo o que o agente digitou. `queued`
        é quanto a mensagem já esperou a vez antes de chegar aqui (só entra no resumo do log).
        """
        target = unicodedata.normalize("NFC", text)
        trace = _Trace(queued)
        asked = self._monotonic()
        try:
            async with self._lock:
                trace.lock_wait = self._monotonic() - asked
                try:
                    await self._reconcile(target, trace)
                finally:
                    pending, self._pending_field = self._pending_field, None
                    if pending is not None:
                        self._accept(pending)
        except TvSessionError as exc:
            trace.outcome = f"falha:{exc.code}"
            raise
        except BaseException:
            trace.outcome = "interrompido"
            raise
        finally:
            trace.total = trace.queued + (self._monotonic() - asked)
            _log.info("%s", trace.line())

    async def _reconcile(self, target: str, trace: _Trace) -> None:
        now = self._monotonic()
        if self._field_changed(now, target):
            self._last = ""
        edit = plan_edit(self._last, target)
        trace.previous, trace.delete, trace.insert = len(self._last), edit.delete, len(edit.insert)
        if edit.delete == 0 and not edit.insert:
            self._last_at = now
            return
        # Abre a sessão (e renova a hibernação) uma vez, antes de qualquer tecla.
        started = self._monotonic()
        await self._tv.wake()
        trace.wake = self._monotonic() - started
        await self._apply(edit, trace)
        self._last_at = self._monotonic()

    def _field_changed(self, now: float, target: str) -> bool:
        """Passou tempo demais **e** o texto novo não continua nem encurta o que foi digitado.

        Continuação ("mat" -> "matrix") ou apagar parcial ("matrix" -> "mat") é o mesmo campo,
        qualquer que seja a pausa: tratar como campo novo duplicaria ("matmatrix"). Só uma troca
        radical depois de uma pausa longa indica outro campo, e então nada é apagado.

        Quando a TV já informou o estado do campo, `last_text` é o valor real e não há palpite a
        corrigir pelo relógio: o texto novo é comparado com ele, apagando só o que sobra.
        """
        if self._field_counter is not None:
            return False
        if self._last_at is None:
            return True
        if now - self._last_at <= self._idle:
            return False
        return not (target.startswith(self._last) or self._last.startswith(target))

    async def _apply(self, edit: TextEdit, trace: _Trace) -> None:
        # O relógio do campo anda a cada passo que deu certo: uma falha no meio não o "esfria".
        started = self._monotonic()
        try:
            for _ in range(min(edit.delete, MAX_DELETIONS)):
                await self._tv.send_key(DELETE_KEY)
                self._last = self._last[:-1]
                self._last_at = self._monotonic()
        finally:
            trace.erase = self._monotonic() - started
        if edit.insert:
            started = self._monotonic()
            try:
                await self._type(edit.insert, trace)
            finally:
                trace.typing = self._monotonic() - started

    async def _type(self, text: str, trace: _Trace) -> None:
        keys = typing_keys(text) if self._keys else None
        if keys is not None:
            trace.channel = CHANNEL_KEYS
            await self._type_keys(text, keys)
            return
        adb = self._adb
        if adb is not None and is_adb_typable(text):
            trace.channel = CHANNEL_ADB
            try:
                await adb.input_text(text)
            except AdbNotReady as exc:
                # Nada foi executado na TV: o Remote v2 digita o mesmo texto sem repetir efeito.
                trace.adb_unavailable = exc.code
            except AdbError as exc:
                raise TvSessionError(exc.code, exc.message) from None
            else:
                self._typed(text)
                return
            finally:
                trace.adb_wait = getattr(adb, "last_input_wait_seconds", None)
        trace.channel = CHANNEL_REMOTE
        await self._tv.send_text(text)
        self._typed(text)

    async def _type_keys(self, text: str, keys: list[str]) -> None:
        """Uma tecla por caractere, na ordem; `last_text` anda tecla a tecla, como no `DEL`."""
        for index, (char, key) in enumerate(zip(text, keys, strict=True)):
            if index and self._key_pause > 0:
                await self._sleep(self._key_pause)
            try:
                await self._tv.send_key(key)
            except ValueError:
                # O adaptador não conhece a tecla (tabelas fora de sincronia). A mensagem dele
                # cita a tecla, e a tecla é um caractere do texto: nada disso vai para o log.
                raise TvSessionError(
                    TEXT_KEY_UNSUPPORTED, "a TV não aceita esta tecla de digitação"
                ) from None
            self._typed(char)

    def _typed(self, text: str) -> None:
        self._last += text
        self._last_at = self._monotonic()
