"""Digitação confiável: em vez de reenviar o campo inteiro, só aplica a diferença.

O app manda o texto completo a cada pausa de digitação. O controle remoto (Remote v2) **insere** o
que recebe no campo da TV, então reenviar o texto inteiro duplicava letras, e apagar não existia.
Aqui o agente guarda o que ele mesmo digitou (`last_text`) e a cada mensagem:

1. calcula o prefixo que o texto novo tem em comum com o anterior;
2. apaga o excedente com `DEL` (teclas curtas, uma a uma);
3. digita só o acréscimo.

A digitação escolhe o canal para o acréscimo inteiro. Se uma tecla falhar, o ADB só recebe o
restante quando o que já saiu pelo socket está provado (ver `_type_keys`): o Remote v2 não confirma
a tecla aplicada, e o ADB por cima de uma letra perdida gravaria o texto truncado. Do mais rápido
para o mais lento:

* **teclas do controle remoto** (opcional, `keys=True`): cada caractere é um pacote no mesmo fluxo
  do `DEL`, sem processo novo. Só vale quando **todos** os caracteres do acréscimo têm tecla sem
  ambiguidade (ver `TYPING_KEYS`); senão o acréscimo inteiro segue pelos canais abaixo. Por quê:
  teclas e `send_text` chegam à TV por caminhos diferentes (o
  `send_text` usa contadores que a própria TV empurra a cada edição do campo), então um trecho
  enviado logo depois de teclas poderia chegar fora de ordem ou com contadores velhos, e o `await`
  não prova entrega (a biblioteca só enfileira no mesmo socket). Dentro do mesmo fluxo de teclas (o
  `DEL` e as letras) a ordem é a do socket;
* **ADB** (`input text`) quando é ASCII imprimível (inclusive `%`) e o canal está pronto: um
  processo `adb` por grupo, e no Android TV o `input text` sobe uma JVM a cada chamada. O acréscimo
  vira **um** grupo na maioria das vezes; só se divide onde o Android leria um `%` literal seguido
  de `s` como espaço, ou acima de `adb_group_chars`. Cada grupo é confirmado (o `adb shell`
  só volta depois de a TV injetar as teclas) antes de `last_text` andar e de o próximo sair. Se
  um grupo falha **sem** ter chegado à TV (o canal nem abriu), o campo tem os anteriores e o
  reenvio do app (sempre o texto completo) digita só o que falta. Se a falha é **ambígua**
  (tempo estourado, saída de erro depois de executar, conexão caída no meio:
  `may_have_executed`), a TV pode ter digitado o grupo inteiro ou parte dele, e a base fica
  marcada como duvidosa. Só um eco do campo (mesmo contador) **igual ao confirmado mais o
  grupo inteiro** resolve a dúvida: ele prova o grupo digitado. Um eco intermediário (a TV ecoa
  cada tecla, e ecos velhos chegam atrasados) não prova nada e é ignorado. Sem esse eco, o campo
  é tratado como desconhecido. O próximo texto apaga (`DEL`) e redigita tudo. Com posse do
  campo, a limpeza inclui o tamanho do grupo incerto. Sem posse, usa o limite de caracteres que
  sabemos que sobraram do agente, para preservar o texto anterior. O `await` de um `DEL` não prova
  que ele chegou: se a limpeza cai no meio, a retomada confere um relato novo do campo e só
  recomeça a limpeza inteira com a posse do campo (ver `_resync`). Trocar de campo ou de app
  desfaz a dúvida. Matar o processo `adb` no PC não garante que o `input` da TV parou, e teclas
  que chegam depois de um `DEL` do refazer ainda podem embaralhar o campo.
  Nunca se insere em cima de uma base velha;
* **Remote v2** (`send_text`) para o resto (acentos, emoji, controle, e quando o ADB não está
  pronto). Um texto com um caractere só do Remote vai **inteiro** por ele, nunca dividido entre
  canais: é um envio só e rápido, e a ordem não depende de dois caminhos.

A ordem entre canais tem dois sentidos. Do ADB para o Remote é segura: o `adb shell input` só
volta com as teclas já injetadas. Do Remote para o ADB não: o `await` só prova que o pacote entrou
no socket. Por isso, depois de um `send_text` pelo Remote (o caso raro: letra acentuada seguida de
ASCII), o primeiro grupo ADB espera `remote_settle_seconds` contados do envio (ajuste
`tv_text_remote_settle_ms`). O mesmo vale depois de uma sequência longa de teclas (`DEL` ou
digitação, `SETTLE_KEY_RUN` ou mais), em que a TV pode ainda estar processando quando o `input
text` injetar. Poucas teclas não esperam: corrigir uma letra é o caso comum, e o processo `adb`
leva muito mais que isso para sair, então o pacote já saiu na frente.

Quando a TV informa o estado do campo em foco (valor, cursor, rótulo), `last_text` parte do valor
real em vez do palpite, e a troca de campo vem por esse aviso, não pela pausa de 20 s (ver
`observe_field`). Sem esse aviso, o comportamento é exatamente o descrito acima.

Se uma edição falha depois de enviar `DEL`, o agente preserva a base anterior. Um eco com o valor
esperado confirma a edição. Sem esse eco, a próxima edição esvazia o campo e redigita o texto. A
dúvida é do campo em que nasceu: outro campo informado pela TV (mesmo depois de uma reconexão), ou,
sem esse aviso, um texto sem relação depois da pausa de `field_idle_seconds`, a descarta.

Cada comando deixa **uma** linha de resumo no log (tamanhos, canal e duração de cada fase), sem o
texto: o que se digita pode ser uma senha.
"""

import asyncio
import logging
import string
import time
import unicodedata
from collections.abc import Awaitable, Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final, Protocol

from uniover_agent.core.tv.session import TV_UNREACHABLE, TvSessionError
from uniover_agent.ports import (
    AdbError,
    AdbNotReady,
    TextFieldStatus,
    adb_text_groups,
    is_adb_typable,
)

_log = logging.getLogger(__name__)

# Sem digitação por este tempo, o campo em foco pode já não ser o mesmo. Só vira campo novo se o
# texto também mudou por completo (não é continuação nem apagar parcial): ver `_field_changed`.
FIELD_IDLE_SECONDS: Final = 20.0
# Teto de teclas `DEL` por mensagem (o texto tem no máximo 200 caracteres).
MAX_DELETIONS: Final = 200
DELETE_KEY: Final = "DEL"
# Tamanho máximo de um grupo do ADB (um `input text`): uma falha custa no máximo um grupo.
ADB_GROUP_CHARS: Final = 80
# A partir de tantas teclas seguidas pelo Remote, o ADB espera a acomodação (ver o módulo).
SETTLE_KEY_RUN: Final = 8
RESYNC_INCOMPLETE: Final = "text_resync_incomplete"
RESYNC_ABANDONED: Final = "text_resync_abandoned"

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

    async def send_key(
        self,
        key: str,
        direction: str = "SHORT",
        *,
        validate: Callable[[], None] | None = None,
        retry_uncertain: bool = True,
    ) -> object: ...

    async def send_text(self, text: str, *, validate: Callable[[], None] | None = None) -> None: ...

    async def wake(self) -> None: ...


class AdbTyping(Protocol):
    """O pedaço do canal ADB que digita (o adaptador implementa `TvAdb`).

    Se o adaptador também expõe `last_input_wait_seconds` (quanto o último `input_text` esperou a
    trava do ADB, que os comandos de apps compartilham), o valor entra no resumo do log.
    """

    async def input_text(
        self, text: str, *, before_send: Callable[[], None] | None = None
    ) -> None: ...


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
class _ErasePlan:
    """A limpeza do refazer: a faixa do texto do agente que ainda pode estar no campo.

    `floor` é o saldo da limpeza iniciado no mínimo seguro sem posse, ou no máximo com posse.
    Dele se desconta todo `DEL` que pode ter saído (à esquerda pode haver texto do dono).
    `ceiling` só desconta o que foi provado (um relato fresco do campo): é o máximo que ainda pode
    faltar, e com a posse é o que a retomada apaga (`DEL` a mais caem no campo vazio).

    `link` é a conexão em que os `DEL` descontados de `floor` seguem em ordem no socket: na mesma
    conexão, sem interrupção, a limpeza continua do `floor`. `None` depois de uma queda, de um
    cancelamento ou de uma reconexão: o desconto deixa de valer e a retomada segue a posse.
    """

    floor: int
    ceiling: int
    link: int | None


@dataclass(frozen=True, slots=True)
class _TextDoubt:
    expected: str
    floor: int
    ceiling: int


@dataclass(slots=True)
class _BufferedIme:
    """Envio sem eco do valor inteiro, preso ao campo e à sessão em que saiu."""

    counter: int | None
    expected: str
    lost: bool = False
    report: TextFieldStatus | None = None


@dataclass(slots=True)
class _Trace:
    """O que um comando de texto fez e quanto cada fase levou. Nunca guarda o texto."""

    queued: float
    previous: int = 0
    delete: int = 0
    insert: int = 0
    groups: int = 0
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
        groups = f"grupos={self.groups} " if self.groups > 1 else ""
        fallback = f" adb_indisponivel={self.adb_unavailable}" if self.adb_unavailable else ""
        return (
            f"texto anterior={self.previous} apagar={self.delete} inserir={self.insert} "
            f"{groups}"
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
        remote_settle_seconds: float = 0.0,
        adb_group_chars: int = ADB_GROUP_CHARS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        remote_connected: Callable[[], bool] | None = None,
    ) -> None:
        self._tv = tv
        self._remote_connected = remote_connected
        self._buffered_ime: _BufferedIme | None = None
        self._monotonic = monotonic
        self._idle = field_idle_seconds
        self._keys = keys
        self._key_pause = key_pause_seconds
        self._remote_settle = remote_settle_seconds
        self._adb_group_chars = adb_group_chars
        self._remote_at: float | None = None
        # Valor esperado pelo eco, mínimo seguro e máximo possível depois da edição incerta.
        self._uncertain: _TextDoubt | None = None
        # A limpeza do refazer em curso ou interrompida (ver `_ErasePlan`): o único registro do
        # quanto ainda apagar, carregado da limpeza para a redigitação e para a retomada.
        self._erase: _ErasePlan | None = None
        # Relato do campo da dúvida chegado depois da interrupção, inclusive durante a abertura
        # da sessão nova: o retrato fresco que a retomada confere (ver `_resume_erase`).
        self._erase_report: TextFieldStatus | None = None
        # Muda quando uma queda, sessão nova ou troca de app invalida a limpeza em curso.
        self._link = 0
        self._focus_generation = 0
        # Maior sequência observada do campo e seu valor no instante da interrupção.
        self._field_sequence: tuple[int, int] | None = None
        self._erase_sequence: int | None = None
        # Contador do campo em que a dúvida nasceu (`None`: a TV não informou o campo). Outro campo
        # descarta a dúvida: o refazer nunca apaga o texto de um campo que o agente não editou.
        self._doubt_counter: int | None = None
        # Contador do campo da edição em curso (o de antes de uma queda zerar `_field_counter`).
        self._edit_counter: int | None = None
        # Posse do campo: `last_text` é o conteúdo que a TV informou do campo (valor adotado ou que
        # bateu com a base), mais as edições do próprio agente. Nunca vem só do contador: um relato
        # recusado (sem bater com a base) deixa um texto desconhecido possível à esquerda.
        self._owns_field = False
        # A posse no instante em que a dúvida nasceu: o refazer dela a herda.
        self._doubt_owns_field = False
        # Durante o refazer o conteúdo antigo do campo é desconhecido: nenhum eco prova as teclas.
        self._resyncing = False
        # Último eco do campo (mesmo contador) que chegou com uma edição nossa em andamento.
        self._echo: TextFieldStatus | None = None
        self._sleep = sleep
        self._adb: AdbTyping | None = None
        self._last = ""
        self._last_at: float | None = None
        self._field_counter: int | None = None
        self._pending_field: TextFieldStatus | None = None
        # Relatos descartados por sessões novas no meio da edição: não semeiam base nenhuma (são da
        # sessão antiga), mas seguem provando que o foco do plano em curso mudou. Todos ficam: um
        # relato posterior do mesmo campo do plano não apaga a prova de uma troca anterior.
        self._dropped_fields: list[TextFieldStatus] = []
        self._app: str | None = None
        self._lock = asyncio.Lock()
        # A validade da edicao em curso (so o canal direto a da); lida e escrita sob a trava.
        self._validate: Callable[[], None] | None = None
        # Teclas (`DEL` e letras) que saíram pelo socket do Remote v2 no comando em curso: nenhuma
        # tem confirmação de que a TV a aplicou (ver `_type_keys`).
        self._socket_keys = 0
        # Caracteres que o ADB confirmou neste comando: as únicas inserções provadas no campo.
        self._adb_confirmed = 0
        # Trecho enviado sem confirmação pelo ADB ou pelo Remote que pode ter chegado à TV.
        self._unconfirmed_text = ""

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
        self._observe_buffered_ime(field)
        sequence = field.ime_counter
        previous = self._sequence_for(field.counter)
        if sequence is not None and (previous is None or sequence > previous):
            if self._doubt_counter is None or field.counter == self._doubt_counter:
                self._field_sequence = (field.counter, sequence)
        if (
            self._erase is not None
            and self._erase.link is None
            and self._doubt_counter is not None
            and field.counter == self._doubt_counter
            and self._erase_sequence is not None
            and sequence is not None
            and sequence > self._erase_sequence
            and (previous is None or sequence > previous)
        ):
            # A sequência precisa avançar: um eco velho também pode chegar depois da queda.
            self._erase_report = field
        if self._lock.locked():
            if field.counter != self._field_counter:
                self._pending_field = field
            else:
                self._echo = field
            return
        if self._uncertain is not None and field.counter == self._field_counter:
            self._resolve_doubt(field)
            return
        self._accept(field)

    def _sequence_for(self, counter: int | None) -> int | None:
        sequence = self._field_sequence
        return sequence[1] if sequence is not None and sequence[0] == counter else None

    def _observe_buffered_ime(self, field: TextFieldStatus) -> None:
        buffered = self._buffered_ime
        if buffered is None:
            return
        changed = buffered.counter is not None and field.counter != buffered.counter
        sequence = self._sequence_for(field.counter)
        fresh = sequence is None or (field.ime_counter is not None and field.ime_counter > sequence)
        if buffered.lost:
            if fresh:
                buffered.report = field
        elif not changed and fresh and self._last == unicodedata.normalize("NFC", field.value):
            # Compara com o valor atual: `DEL` e digitação depois do envio também mudam `_last`.
            self._buffered_ime = None

    def forget_session(self) -> None:
        """Invalida a sessão que podia entregar os lotes ainda sem eco."""
        if self._buffered_ime is not None:
            self._buffered_ime.lost = True
            self._buffered_ime.report = None
        self.forget_field()

    def forget_field(self) -> None:
        """Esquece o estado do campo: nova sessão com a TV ou outro app em foco.

        Sem estado fresco do campo atual volta o comportamento conservador de antes: a base é o
        que o agente digitou e a pausa de `field_idle_seconds` decide se o campo é outro. Nunca se
        apaga com base em estado velho. A abertura invalida o campo antes de o novo canal poder
        emitir seus próprios relatos.
        """
        self._field_counter = None
        if self._pending_field is not None:
            # A TV pode não repetir o relato na sessão nova: a troca de foco não pode sumir junto.
            self._dropped_fields.append(self._pending_field)
        self._pending_field = None
        self._echo = None
        self._owns_field = False
        plan = self._erase
        if plan is not None and plan.link is not None:
            # Os `DEL` descontados estavam no socket antigo e podem ter se perdido: é interrupção.
            self._interrupt_erase(plan, plan.floor)
        self._erase_report = None  # de antes da sessão nova: não é mais fresco
        self._link += 1

    def observe_app(self, app: str) -> None:
        """O app em foco mudou? Então o estado do campo era de outro lugar.

        A TV repete o app a cada eco de edição; só a troca de verdade esquece o estado.
        """
        previous, self._app = self._app, app
        recovering = (
            self._uncertain is not None or self._resyncing or self._buffered_ime is not None
        )
        if previous != app and (previous is not None or (recovering and self._lock.locked())):
            self._focus_generation += 1
            if recovering:
                # A base do refazer também era do app anterior.
                self._last = ""
                self._last_at = None
            self.forget_field()
            self._field_sequence = None
            self._buffered_ime = None
            self._clear_doubt()

    def _accept(self, field: TextFieldStatus) -> None:
        buffered = self._buffered_ime
        if (
            buffered is not None
            and buffered.counter is not None
            and field.counter != buffered.counter
        ):
            self._buffered_ime = None
            self._last_at = None  # o valor informado do campo novo vai semear o próximo diff
            self._field_counter = None
        previous, self._field_counter = self._field_counter, field.counter
        if previous == field.counter:
            return
        if previous is None and self._last_at is not None:
            if (
                self._uncertain is not None
                and self._doubt_counter is not None
                and field.counter != self._doubt_counter
            ):
                # Depois de uma reconexão chegou outro campo: a dúvida era do anterior.
                self._last = unicodedata.normalize("NFC", field.value)
                self._last_at = self._monotonic()
                self._owns_field = True
                self._clear_doubt()
                return
            if self._uncertain is None:
                # Só registra o contador; a posse vem só se o valor bate com o que foi digitado.
                self._owns_field = unicodedata.normalize("NFC", field.value) == self._last
                return
            self._resolve_doubt(field)
            return
        self._last = unicodedata.normalize("NFC", field.value)
        self._last_at = self._monotonic()
        self._owns_field = True
        self._clear_doubt()  # outro campo, ou o valor real: a dúvida não vale mais

    def _check(self) -> None:
        """Antes de planejar qualquer coisa: o canal que pediu esta edição ainda vale?"""
        if self._validate is not None:
            self._validate()

    def _check_effect(self) -> None:
        self._check()
        if self._lost_ime() is not None:
            raise TvSessionError(TV_UNREACHABLE, "a TV não confirmou a entrega do texto anterior")

    def _effect(self) -> TextControl:
        """A TV, para um efeito (acordar, tecla, texto): o canal que pediu ainda vale?

        Roda sob a trava das edições, então `_validate` é o da edição em curso. Com o canal fechado
        (revogação, troca, queda) nada mais vai à TV: levanta `TvSessionError`."""
        self._check_effect()
        return self._tv

    def _lost_ime(self) -> _BufferedIme | None:
        buffered = self._buffered_ime
        if buffered is None:
            return None
        if self._remote_connected is not None and not self._remote_connected():
            buffered.lost = True
            buffered.report = None
        return buffered if buffered.lost else None

    async def _recover_buffered_ime(self, buffered: _BufferedIme, target: str) -> None:
        # O próximo comando pode chegar antes da recuperação automática ou ser igual ao anterior.
        # Abre a sessão antes de calcular qualquer diferença e só usa relatos do canal novo.
        await self._tv.wake()
        self._check()
        if self._buffered_ime is not buffered:
            raise TvSessionError(RESYNC_ABANDONED, "o campo da TV mudou na reconexão")
        self._lost_ime()  # invalida o relato se a sessão recém-aberta também caiu
        report = buffered.report
        if report is not None:
            actual = unicodedata.normalize("NFC", report.value)
            if buffered.counter is not None and report.counter != buffered.counter:
                self._buffered_ime = None
                self._last_at = None
                self._field_counter = None
                self._accept(report)
                raise TvSessionError(RESYNC_ABANDONED, "o campo da TV mudou na reconexão")
            # O relato permite completar só o que falta, sem apagar nem repetir às cegas.
            if actual == target or (buffered.counter is not None and target.startswith(actual)):
                self._last = actual
                self._last_at = self._monotonic()
                self._field_counter = report.counter
                self._owns_field = True
                self._buffered_ime = None
                self._clear_doubt()
                return
        raise TvSessionError(
            TV_UNREACHABLE, "a TV não confirmou a entrega do texto anterior", may_have_sent=True
        )

    def _focus_changed(self, counter: int | None, generation: int) -> bool:
        return self._focus_generation != generation or any(
            field is not None and field.counter != counter
            for field in (self._pending_field, *self._dropped_fields)
        )

    @contextmanager
    def _guard_edit_field(self, link: int | None) -> Iterator[None]:
        """O plano pertence ao foco observado e, na recuperação do IME, também à conexão."""
        counter, generation, upstream = self._field_counter, self._focus_generation, self._validate

        def focus_changed() -> bool:
            if counter is None:
                # Sem contador no plano, o primeiro relato pode ser um eco desta edição.
                return self._focus_generation != generation
            return self._focus_changed(counter, generation)

        def validate() -> None:
            link_changed = link is not None and self._link != link
            if focus_changed() or link_changed:
                raise TvSessionError(RESYNC_ABANDONED, "o campo da TV mudou durante a edição")
            if upstream is not None:
                upstream()

        self._validate = validate
        try:
            yield
        finally:
            self._validate = upstream
            if focus_changed():
                self._forget_edit_field()

    def _forget_edit_field(self) -> None:
        """A base e os envios incertos pertencem ao foco antigo.

        Se houver um relato pendente do campo novo, ele será a base da próxima edição.
        """
        self._last = ""
        self._last_at = None
        self._field_counter = None
        self._echo = None
        self._owns_field = False
        self._buffered_ime = None
        self._clear_doubt()

    async def set_text(
        self, text: str, *, queued: float = 0.0, validate: Callable[[], None] | None = None
    ) -> None:
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
                # Só vale depois de obter a vez: quem esperava a trava foi revogado enquanto isso?
                self._validate = validate
                try:
                    self._check()
                    await self._reconcile(target, trace)
                finally:
                    self._validate = None
                    self._dropped_fields.clear()  # só valiam contra o plano desta edição
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
        self._socket_keys = 0
        self._adb_confirmed = 0
        self._unconfirmed_text = ""
        recovered_link = None
        if (buffered := self._lost_ime()) is not None:
            await self._recover_buffered_ime(buffered, target)
            recovered_link = self._link
        now = self._monotonic()
        self._edit_counter = (
            self._field_counter if self._field_counter is not None else self._doubt_counter
        )
        uncertain = self._uncertain
        if uncertain is not None and self._doubt_outlived(now, target, uncertain.expected):
            self._clear_doubt()
            uncertain = None
        if uncertain is not None and not self._resolve_doubt(self._echo):
            counter, generation = self._edit_counter, self._focus_generation
            try:
                await self._resync(target, uncertain, trace)
            except TvSessionError, asyncio.CancelledError:
                if self._focus_changed(counter, generation):
                    # Outro app ou outro campo: a dúvida, a limpeza e a base eram do campo antigo
                    # e não podem mandar `DEL` ao campo que tem o foco agora.
                    self._forget_edit_field()
                raise
            return
        if self._field_changed(now, target):
            self._last = ""
            self._owns_field = False
            self._buffered_ime = None
        edit = plan_edit(self._last, target)
        trace.previous, trace.delete, trace.insert = len(self._last), edit.delete, len(edit.insert)
        if edit.delete == 0 and not edit.insert:
            self._last_at = now
            return
        # Abre a sessão (e renova a hibernação) uma vez, antes de qualquer tecla.
        with self._guard_edit_field(recovered_link):
            started = self._monotonic()
            await self._effect().wake()
            trace.wake = self._monotonic() - started
            self._check_effect()
            await self._apply(edit, trace)
            self._last_at = self._monotonic()

    def _doubt(self, group: str) -> None:
        """Um grupo falhou de um jeito ambíguo: a base passa a ser duvidosa.

        Se a TV já ecoou o campo durante o comando (com eco coerente), a dúvida se resolve na hora.
        """
        expected = self._last + group
        self._set_doubt(expected, floor=len(self._last), ceiling=len(expected))

    def _set_doubt(
        self, expected: str, *, floor: int, ceiling: int, owned: bool | None = None
    ) -> None:
        self._uncertain = _TextDoubt(expected, floor, ceiling)
        self._doubt_counter = self._edit_counter
        self._doubt_owns_field = self._owns_field if owned is None else owned
        self._reset_erase()
        if not self._resyncing:
            self._resolve_doubt(self._echo)

    def _clear_doubt(self) -> None:
        self._uncertain = None
        self._doubt_counter = None
        self._doubt_owns_field = False
        self._reset_erase()

    def _reset_erase(self) -> None:
        self._erase = None
        self._erase_report = None
        self._erase_sequence = None

    def _doubt_outlived(self, now: float, target: str, expected: str) -> bool:
        """Sem o campo informado pela TV, a dúvida vale só para o mesmo campo, como a base.

        Passada a pausa de `field_idle_seconds`, um texto que não continua nem encurta o esperado
        (nem a base anterior) é de outro campo: nada se apaga lá (ver `_field_changed`).
        """
        if not self._field_changed(now, target):
            return False
        return not (target.startswith(expected) or expected.startswith(target))

    def _resolve_doubt(self, field: TextFieldStatus | None) -> bool:
        """Só o eco com o valor esperado prova a edição e vira o `last_text`.

        Ecos intermediários (`abcd` de `abc` + `def`) ou atrasados (o estado do grupo anterior) não
        provam nada. Com a limpeza do refazer registrada (`_erase`) o campo está mudando: nada vale.
        """
        if self._uncertain is None:
            return True
        if field is None or self._erase is not None:
            return False
        expected = self._uncertain.expected
        if unicodedata.normalize("NFC", field.value) != expected:
            return False
        self._last = expected
        self._last_at = self._monotonic()
        self._owns_field = True  # o campo informado bateu com o esperado
        self._clear_doubt()
        self._echo = None
        return True

    async def _resync(self, target: str, doubt: _TextDoubt, trace: _Trace) -> None:
        """Sem eco que prove o campo: usa o limite seguro para a posse e redigita tudo.

        `last_text` só é zerado quando todos os `DEL` saíram: no meio, o que sai primeiro é o trecho
        desconhecido, então o confirmado não encurta passo a passo como num apagar comum. Em vez
        disso o registro da limpeza (`_ErasePlan`) conta os `DEL` que ainda faltam e anda a cada um
        que saiu. O teto de `MAX_DELETIONS` por mensagem continua do ponto onde parou na próxima,
        se a conexão é a mesma.

        Uma queda ou uma reconexão é diferente: o `await` só prova que o `DEL` entrou no socket, e
        os que ficaram nele se perdem. O que falta é a faixa do registro, e a retomada
        (`_resume_erase`) não segue o saldo descontado: confere um relato fresco do campo, ou
        recomeça a limpeza inteira se a dúvida tinha a posse; sem posse, apaga no máximo o mínimo
        que pode faltar (sobrar texto é melhor que apagar o do dono). O mesmo registro segue para a
        redigitação: se ela cai, os `DEL` desta limpeza continuam sem confirmação.
        """
        link, counter, generation = self._link, self._edit_counter, self._focus_generation
        upstream = self._validate
        owned = self._doubt_owns_field

        def focus_moved() -> bool:
            return self._focus_changed(counter, generation)

        def validate_focus() -> None:
            if focus_moved() or self._link != link:
                raise TvSessionError(RESYNC_ABANDONED, "o campo da TV mudou no refazer")
            if upstream is not None:
                upstream()

        def validate_erase() -> None:
            if self._uncertain is None:
                raise TvSessionError(RESYNC_ABANDONED, "o campo da TV mudou no refazer")
            validate_focus()

        self._echo = None  # um eco de antes do refazer não prova nada do que vem agora
        started = self._monotonic()
        await self._effect().wake()
        trace.wake = self._monotonic() - started
        # Um relato fresco do mesmo campo identifica onde a limpeza interrompida pode continuar.
        if self._erase_report is not None:
            link = self._link
        validate_erase()
        plan = self._erase
        if plan is None:
            plan = _ErasePlan(doubt.ceiling if owned else doubt.floor, doubt.ceiling, self._link)
        elif plan.link != self._link:
            plan = self._resume_erase(plan)
        self._erase = plan
        trace.previous, trace.delete, trace.insert = len(self._last), plan.floor, len(target)
        started = self._monotonic()
        try:
            await self._erase_resync(plan, validate_erase)
        finally:
            trace.erase = self._monotonic() - started
        if plan.floor > 0:
            raise TvSessionError(RESYNC_INCOMPLETE, "o campo da TV é grande demais para refazer")
        self._last = ""
        # O campo só está vazio de fato se a dúvida tinha a posse: o máximo dela era exato. Sem
        # ela, pode ter sobrado à esquerda um texto que o agente não conhece.
        self._owns_field = owned
        self._clear_doubt()
        self._last_at = self._monotonic()
        if target:
            await self._retype_resync(
                target,
                trace,
                plan=plan,
                owned=owned,
                validate=validate_focus,
                focus_moved=focus_moved,
            )
        self._last_at = self._monotonic()

    async def _retype_resync(  # noqa: PLR0913 - a limpeza e as verificações do campo que a originou
        self,
        target: str,
        trace: _Trace,
        *,
        plan: _ErasePlan,
        owned: bool,
        validate: Callable[[], None],
        focus_moved: Callable[[], bool],
    ) -> None:
        started = self._monotonic()
        upstream, self._validate = self._validate, validate
        # Ecos dos DEL (ou atrasados) podem igualar o prefixo redigitado sem provar nada.
        self._echo = None
        self._resyncing = True
        try:
            await self._type(target, trace)
            validate()
        except TvSessionError, asyncio.CancelledError:
            if focus_moved():
                raise  # outro app ou outro campo: a recuperação era do campo antigo
            self._doubt_retype(plan.ceiling, owned=owned)
            raise
        finally:
            self._validate = upstream
            self._resyncing = False
            self._echo = None
            trace.typing = self._monotonic() - started

    def _doubt_retype(self, ceiling: int, *, owned: bool) -> None:
        """A redigitação do refazer caiu: vira uma limpeza interrompida, com a mesma faixa.

        Nenhum `DEL` da limpeza nem tecla redigitada tem confirmação. O máximo é o esperado mais o
        `ceiling` da limpeza (o que ela ainda podia ter a apagar, sem repetir o que um piso já
        descontou). O mínimo é só o que o ADB confirmou: o resto pode não ter chegado, e sem a
        posse do campo apagar além disso alcançaria o texto do dono à esquerda.
        """
        unconfirmed, self._unconfirmed_text = self._unconfirmed_text, ""
        if self._uncertain is not None:
            expected = self._uncertain.expected  # a digitação já registrou a dúvida do trecho
        else:
            expected = self._last + unconfirmed
        floor = min(self._adb_confirmed, len(self._last))
        self._last = ""
        most = len(expected) + ceiling
        self._set_doubt(expected, floor=floor, ceiling=most, owned=owned)
        self._erase = _ErasePlan(floor, most, None)
        self._erase_sequence = self._sequence_for(self._doubt_counter)

    async def _erase_resync(self, plan: _ErasePlan, validate: Callable[[], None]) -> None:
        """Manda até MAX_DELETIONS teclas do refazer; `plan.floor` anda a cada uma que saiu."""
        sent = 0
        while plan.floor > 0 and sent < MAX_DELETIONS:
            try:
                await self._tv.send_key(DELETE_KEY, validate=validate, retry_uncertain=False)
                self._socket_keys += 1
                plan.floor -= 1
                sent += 1
                validate()
            except TvSessionError as exc:
                # O envio que falhou também conta se pode ter saído.
                self._interrupt_erase(plan, plan.floor - int(exc.may_have_sent), sent)
                raise
            except asyncio.CancelledError:
                self._interrupt_erase(plan, plan.floor - 1, sent)
                raise
        self._mark_key_run(sent)

    def _interrupt_erase(self, plan: _ErasePlan, floor: int, sent: int | None = None) -> None:
        """A limpeza do refazer caiu no meio, ou a conexão dela mudou: o saldo vira um mínimo.

        `floor` já desconta todo `DEL` que pode ter saído. Um relato de antes da queda não vale.
        """
        plan.floor = max(floor, 0)
        if plan.link is None:
            return  # uma reconexão já invalidou o relato antigo; pode haver um relato novo
        plan.link = None
        if self._erase is not plan:
            return  # a dúvida já se desfez (outro app, outro campo)
        if sent is not None:
            _log.info("limpeza do refazer interrompida depois de %s DEL", sent)
        self._erase_report = None
        self._erase_sequence = self._sequence_for(self._doubt_counter)

    def _resume_erase(self, plan: _ErasePlan) -> _ErasePlan:
        """Quantos `DEL` a limpeza interrompida manda agora (o saldo descontado não vale mais).

        * relato fresco do campo e posse: o tamanho informado (nunca acima do máximo da faixa);
        * relato sem posse: o menor entre ele e o mínimo que pode faltar, porque o relato não diz
          onde começa um texto do dono à esquerda;
        * sem relato e com posse: a limpeza inteira de novo (`DEL` a mais caem no campo vazio);
        * sem relato e sem posse: só o mínimo que pode faltar. Pode sobrar texto do agente, mas
          nunca se apaga além do que ele pode ter escrito.
        """
        # A retomada consome a interrupção: o que sair daqui em diante é contado de novo.
        report, self._erase_report = self._erase_report, None
        self._erase_sequence = None
        ceiling, floor = plan.ceiling, plan.floor
        if report is not None:
            ceiling = min(ceiling, len(unicodedata.normalize("NFC", report.value)))
            floor = min(floor, ceiling)
        send = ceiling if self._doubt_owns_field else floor
        return _ErasePlan(send, ceiling, self._link)

    def _mark_key_run(self, count: int) -> None:
        """Depois de uma sequência longa de teclas, o ADB espera a TV acomodá-las (ver o módulo)."""
        if count >= SETTLE_KEY_RUN:
            self._remote_at = self._monotonic()

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
        previous = self._last
        owned, generation = self._owns_field, self._focus_generation
        deleted = 0
        attempted = False
        maybe_deleted = False
        self._echo = None  # só o eco desta edição prova alguma coisa
        try:
            started = self._monotonic()
            try:
                for _ in range(min(edit.delete, MAX_DELETIONS)):
                    tv = self._effect()
                    attempted = True
                    try:
                        await tv.send_key(
                            DELETE_KEY, validate=self._check_effect, retry_uncertain=False
                        )
                    except TvSessionError as exc:
                        maybe_deleted = exc.may_have_sent
                        raise
                    except asyncio.CancelledError:
                        maybe_deleted = True
                        raise
                    deleted += 1
                    self._socket_keys += 1
                    self._last = self._last[:-1]
                    self._last_at = self._monotonic()
            finally:
                trace.erase = self._monotonic() - started
            self._mark_key_run(deleted)
            if edit.insert:
                started = self._monotonic()
                try:
                    await self._type(edit.insert, trace)
                finally:
                    trace.typing = self._monotonic() - started
        except TvSessionError, asyncio.CancelledError:
            if attempted and generation == self._focus_generation:
                # O socket pode ter perdido os `DEL` enviados, inclusive o envio que falhou.
                floor = len(previous) - deleted - int(maybe_deleted) + self._adb_confirmed
                self._doubt_deletes(previous, deleted, floor=max(0, floor), owned=owned)
            raise

    def _doubt_deletes(self, base: str, deleted: int, *, floor: int, owned: bool) -> None:
        """`DEL` sem confirmação: a base volta a `base` até um eco provar o valor esperado.

        O esperado é o que o agente acredita ter feito (ou a dúvida que a digitação já registrou);
        sem eco, o refazer apaga até o maior tamanho possível: o esperado mais os `DEL` enviados.

        O trecho incerto entra no máximo. O mínimo desconta todo `DEL` que pode ter chegado e só
        conta inserções confirmadas. Sem posse, o mínimo protege o texto do dono à esquerda.
        """
        unconfirmed, self._unconfirmed_text = self._unconfirmed_text, ""
        if self._uncertain is not None:
            expected = self._uncertain.expected
        else:
            expected = self._last + unconfirmed
        self._last = base
        self._set_doubt(expected, floor=floor, ceiling=len(expected) + deleted, owned=owned)

    async def _type(self, text: str, trace: _Trace) -> None:
        keys = typing_keys(text) if self._keys else None
        if keys is not None:
            trace.channel = CHANNEL_KEYS
            text = await self._type_keys(text, keys)
            if not text:
                return
        adb = self._adb
        rest = text
        if adb is not None and is_adb_typable(text):
            trace.channel = CHANNEL_ADB
            rest = await self._type_adb(adb, text, trace)
            if not rest:
                return
            trace.channel = CHANNEL_REMOTE if rest == text else f"{CHANNEL_ADB}+{CHANNEL_REMOTE}"
        else:
            trace.channel = CHANNEL_REMOTE
        trace.groups += 1
        tv = self._effect()
        try:
            await tv.send_text(rest, validate=self._check_effect)
        except TvSessionError as exc:
            # Só a queda já dentro do envio deixa o trecho incerto; uma falha anterior (sessão que
            # não abriu, transporte fechando) prova que nada saiu. Quem registrar a dúvida dos
            # `DEL` conta este trecho. Sem `DEL`, a próxima edição espera um relato novo do campo.
            if exc.may_have_sent:
                self._unconfirmed_text = rest
                if (
                    self._remote_connected is not None
                    and not self._socket_keys
                    and not self._resyncing
                    and self._buffered_ime is None
                ):
                    self._buffered_ime = _BufferedIme(
                        self._edit_counter, self._last + rest, lost=True
                    )
            raise
        self._remote_at = self._monotonic()
        self._typed(rest)
        if self._remote_connected is not None:
            self._buffered_ime = _BufferedIme(self._field_counter, self._last)

    async def _type_adb(self, adb: AdbTyping, text: str, trace: _Trace) -> str:
        """Digita grupo a grupo pelo ADB; devolve o que sobrou para o Remote (`""` se tudo foi).

        Só um `AdbNotReady` levantado antes de o comando ir ao shell da TV (portão fechado, sem
        permissão, canal que não abriu: `may_have_executed` falso) passa o resto ao Remote v2, que
        digita o mesmo texto sem repetir efeito e depois do que o ADB já escreveu. Falha que pode
        ter digitado parte do grupo (tempo estourado, saída de erro, conexão caída no meio) deixa
        a base duvidosa (`_doubt`) e o erro sobe: nada é repetido às cegas.
        """
        pending = adb_text_groups(text, self._adb_group_chars)
        dispatched = False

        def before_send() -> None:
            nonlocal dispatched
            self._check_effect()
            dispatched = True

        for index, group in enumerate(pending):
            self._check()
            await self._settle_after_remote()
            self._check()
            self._echo = None
            dispatched = False
            try:
                await adb.input_text(group, before_send=before_send)
                self._check()
            except TvSessionError, asyncio.CancelledError:
                if dispatched:
                    self._unconfirmed_text = group
                raise
            except AdbError as exc:
                if isinstance(exc, AdbNotReady) and not exc.may_have_executed:
                    trace.adb_unavailable = exc.code
                    return "".join(pending[index:])
                if exc.may_have_executed:
                    if self._resyncing:
                        self._unconfirmed_text = group
                    else:
                        self._doubt(group)
                raise TvSessionError(exc.code, exc.message) from None
            finally:
                trace.adb_wait = getattr(adb, "last_input_wait_seconds", None)
            trace.groups += 1
            self._typed(group)
            self._adb_confirmed += len(group)
        return ""

    async def _settle_after_remote(self) -> None:
        """Dá ao último envio pelo Remote v2 o tempo de chegar antes de o ADB digitar por cima."""
        if self._remote_at is None or self._remote_settle <= 0:
            return
        remaining = self._remote_settle - (self._monotonic() - self._remote_at)
        if remaining > 0:
            await self._sleep(remaining)

    async def _type_keys(self, text: str, keys: list[str]) -> str:
        """Uma tecla por caractere, na ordem; `last_text` anda tecla a tecla, como no `DEL`.

        Devolve o que o ADB ainda deve digitar (`""`: tudo foi). Uma tecla que a TV não conhece
        (`ValueError`) não saiu, e o socket segue vivo e em ordem: o ADB digita o resto depois da
        pausa. Já o socket que caiu (`TvSessionError`) deixa incerto tudo o que saiu por ele neste
        comando: o `await` só prova que o pacote entrou no socket. O ADB só completa quando nada
        saiu por ele, ou quando o eco do campo (mesmo contador) prova o que foi; senão o prefixo
        digitado vira dúvida (`_doubt`, resolvida por eco ou pelo refazer do próximo texto) e o
        erro sobe, sem gravar um texto truncado como concluído.
        """
        for index, (char, key) in enumerate(zip(text, keys, strict=True)):
            if index and self._key_pause > 0:
                await self._sleep(self._key_pause)
            tv = self._effect()
            try:
                await tv.send_key(key, validate=self._check_effect)
            except (ValueError, TvSessionError) as exc:
                if self._adb is None:
                    if isinstance(exc, TvSessionError):
                        raise
                    raise TvSessionError(
                        "text_key_unsupported", "a TV não aceita esta tecla de digitação"
                    ) from None
                if isinstance(exc, TvSessionError) and not self._proven(text[:index]):
                    raise
                if index:
                    self._remote_at = self._monotonic()
                return text[index:]
            self._socket_keys += 1
            self._typed(char)
        self._mark_key_run(len(keys))
        return ""

    def _proven(self, prefix: str) -> bool:
        """O que saiu pelo socket neste comando chegou ao campo? Sem prova, `prefix` vira dúvida.

        Nada saiu: provado. Se só `DEL` saíram, `_apply` registra a dúvida sobre as exclusões."""
        if self._socket_keys == 0:
            return True
        echo = None if self._resyncing else self._echo
        if echo is not None and unicodedata.normalize("NFC", echo.value) == self._last:
            return True
        if prefix:
            self._last = self._last[: len(self._last) - len(prefix)]
            self._doubt(prefix)
        return False

    def _typed(self, text: str) -> None:
        self._last += text
        self._last_at = self._monotonic()
