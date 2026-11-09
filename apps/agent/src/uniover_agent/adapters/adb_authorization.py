"""Permissão do ADB na TV: a chave do PC, a TV a que ela vale e uma cópia que atualização não toca.

O agente usa o `adb` do PC, e quem assina a conexão é o servidor dele, com a chave `adbkey` da pasta
`.android` do usuário (o `adb` do Windows não deixa mudar essa pasta por variável de ambiente, e
o aviso da TV sempre oferece essa chave).
Então aqui a chave não é trocada, e sim **guardada e vigiada**:

* cada chave válida é copiada para `<pasta>/<resumo>/` (restrita ao usuário, dentro da pasta de
  instalação, que atualização e reinstalação não apagam). Cópias de chaves diferentes convivem e
  nenhuma é sobrescrita; cópia que não confere com o próprio nome (truncada, adulterada) é ignorada.
  Se o `adbkey` sumir ou estiver inválido, a cópia da chave registrada volta **antes** de qualquer
  chamada ao `adb` (senão ele gera outra e a TV pergunta de novo). Uma chave válida e diferente
  nunca é sobrescrita (é do usuário, e o Android Studio a usa também);
* por TV, um arquivo diz em que pé está a permissão: `granted` (a TV aceitou, mas ninguém provou
  que ficou gravada), `verified` (uma conexão **nova**, pedida pela pessoa, foi atendida sem aviso)
  ou `needs_user` (a TV pediu o aviso de novo). O registro é amarrado à identidade da TV: endereço
  e porta, MAC (pela tabela ARP, sem ADB) e a chave de agora. Só `verified` com a mesma identidade
  deixa o agente conectar sozinho; qualquer outra coisa (outro endereço, outro aparelho no mesmo
  IP, outra chave) fecha a porta, e só um pedido explícito da pessoa conecta.

Nada aqui registra o conteúdo da chave: só um resumo curto dela (SHA-256) entra no arquivo e no log.
"""

import asyncio
import hashlib
import json
import logging
import math
import os
import secrets
import shutil
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final

from uniover_agent.adapters.arp import arp_mac
from uniover_agent.adapters.tv_discovery import tcp_open
from uniover_agent.adapters.tv_pairing import TvPairingError, prepare_private_dir

_log = logging.getLogger(__name__)

KEY_FILE: Final = "adbkey"
PUBLIC_KEY_FILE: Final = "adbkey.pub"
STATE_FILE: Final = "adb-authorization.json"
# Respostas da TV que não aceitaram desligar o vencimento da permissão (só a resposta dela conta,
# nunca tempo esgotado nem transporte caído). Depois disso o agente desiste do ajuste; a contagem de
# 7 dias da TV só zera quando alguma conexão ADB acontece (um toque no app, uma tarefa dentro da
# janela de presença): não existe contato periódico.
MAX_TIMEOUT_ATTEMPTS: Final = 3
FINGERPRINT_LENGTH: Final = 16
# Tentativas da troca atômica do arquivo de estado (ver `_replace_file`).
_REPLACE_ATTEMPTS: Final = 5
GRANTED: Final = "granted"
VERIFIED: Final = "verified"
NEEDS_USER: Final = "needs_user"
_NONE: Final = ""
_STATES: Final = frozenset({_NONE, GRANTED, VERIFIED, NEEDS_USER})
_PEM_BEGIN: Final = b"-----BEGIN"
_PEM_END: Final = b"-----END"
MAC_PROBE_SECONDS: Final = 1.5

# Por que o agente se recusa a conectar sozinho (só o nome do motivo vai ao diagnóstico e ao log):
GATE_NEVER: Final = "never"  # esta TV nunca deu a permissão a este agente
GATE_TV_REFUSED: Final = "tv_refused"  # a TV recusou a chave (reset, revogação, outra chave)
GATE_UNPROVEN: Final = "unproven"  # a TV aceitou, mas nenhum toque da pessoa provou que gravou
GATE_KEY_CHANGED: Final = "key_changed"  # a chave `adbkey` de agora não é a registrada
GATE_ADDRESS_CHANGED: Final = "address_changed"  # o IP mudou e o MAC não confirma a mesma TV
GATE_DEVICE_CHANGED: Final = "device_changed"  # o MAC de agora é de outro aparelho
GATE_MAC_UNKNOWN: Final = "mac_unknown"  # a ARP não mostra o MAC: a identidade não se confirma
GATE_OTHER: Final = "other"

# O que `rebind` fez: refez o registro, não o refez porque a chave mudou, ou não tinha MAC lido.
REBIND_DONE: Final = "rebound"
REBIND_KEY_CHANGED: Final = "key_changed"
REBIND_NO_MAC: Final = "no_mac"


def default_android_dir() -> Path:
    """A pasta `.android` do usuário, onde o `adb` guarda a chave."""
    return Path.home() / ".android"


KEY_VALID: Final = "valid"
KEY_BROKEN: Final = "broken"
KEY_UNKNOWN: Final = "unknown"
_BOM: Final = b"\xef\xbb\xbf"


def classify_key(data: bytes) -> str:
    """`valid` (PEM inteiro), `broken` (vazia ou truncada: começa e não termina) ou `unknown`.

    Só a `broken` pode ser posta de lado e substituída pela cópia. A `unknown` (outro formato, algo
    que este código não reconhece) é do usuário: não se toca nela nem se registra nada em nome dela.
    """
    text = data.lstrip(_BOM + b" \t\r\n")
    if not text.strip():
        return KEY_BROKEN
    if text.startswith(_PEM_BEGIN):
        return KEY_VALID if _PEM_END in text else KEY_BROKEN
    return KEY_UNKNOWN


def key_fingerprint(data: bytes) -> str | None:
    """Resumo curto de uma chave válida; `None` para vazia, truncada ou de formato desconhecido."""
    if classify_key(data) != KEY_VALID:
        return None
    return hashlib.sha256(data).hexdigest()[:FINGERPRINT_LENGTH]


async def resolve_tv_mac(host: str, port: int) -> str | None:
    """MAC da TV pela tabela ARP, sem ADB: um TCP aberto e fechado na hora popula a tabela.

    Abrir e fechar a porta do ADB não inicia aperto de mão nenhum (o `adbd` só reage ao `CNXN` do
    cliente), então não mostra aviso. `None` se a TV não atende (desligada ou fora da rede); `""`
    se atende e a ARP não a mostra.
    """
    if not await tcp_open(host, port, MAC_PROBE_SECONDS):
        return None
    # Porta aberta e sem MAC na ARP (outra sub-rede, VPN): "" não é TV fora do ar.
    return await arp_mac(host) or ""


@dataclass(frozen=True, slots=True)
class AdbAuthRecord:
    """O que se sabe sobre a permissão desta TV: gravado em disco, sem nada secreto."""

    state: str = _NONE
    fingerprint: str = ""
    endpoint: str = ""
    mac: str = ""
    serial: str = ""
    timeout_disabled: bool = False
    timeout_attempts: int = 0
    granted_at: float = 0.0
    last_handshake_at: float = 0.0


class AdbKeys:
    """A chave do `adb` do usuário e as cópias guardadas na pasta de instalação."""

    def __init__(self, backup_dir: Path, android_dir: Path | None = None) -> None:
        self._backup = backup_dir
        self._android = android_dir if android_dir is not None else default_android_dir()

    @property
    def key_path(self) -> Path:
        return self._android / KEY_FILE

    def fingerprint(self) -> str | None:
        """Resumo da chave em uso, ou `None` se ela não existe ou não está inteira."""
        try:
            return key_fingerprint(self.key_path.read_bytes())
        except OSError:
            return None

    def backups(self) -> list[str]:
        """Resumos das cópias que conferem, da mais nova para a mais velha."""
        try:
            entries = [entry for entry in self._backup.iterdir() if entry.is_dir()]
        except OSError:
            return []
        entries.sort(key=_mtime, reverse=True)
        return [entry.name for entry in entries if self._backup_is_valid(entry.name)]

    def _backup_is_valid(self, fingerprint: str) -> bool:
        try:
            return (
                key_fingerprint((self._backup / fingerprint / KEY_FILE).read_bytes()) == fingerprint
            )
        except OSError:
            return False

    def restore_if_missing(self, prefer: str | None = None) -> bool:
        """Devolve uma cópia que confere se o `adbkey` sumiu ou está inválido.

        Prefere a cópia da chave registrada. Uma chave **válida** nunca é tocada; uma inválida
        (truncada) é posta de lado (`adbkey.invalido`) antes de a cópia voltar.
        """
        try:
            current = self.key_path.read_bytes() if self.key_path.exists() else b""
        except OSError:
            return False
        if classify_key(current) != KEY_BROKEN:
            return False  # válida, ou de um formato que não é nosso: não se toca
        candidates = self.backups()
        if not candidates:
            return False
        chosen = prefer if prefer in candidates else candidates[0]
        try:
            self._android.mkdir(parents=True, exist_ok=True)
            if self.key_path.exists():
                os.replace(self.key_path, self._android / (KEY_FILE + ".invalido"))
            for name in (KEY_FILE, PUBLIC_KEY_FILE):
                source = self._backup / chosen / name
                if source.is_file():
                    shutil.copyfile(source, self._android / name)
                elif name == PUBLIC_KEY_FILE:
                    # Cópia sem `.pub`: o que está ao lado era de outra chave (o `adb` deriva a
                    # pública da privada, mas outras ferramentas leriam a errada).
                    (self._android / name).unlink(missing_ok=True)
        except OSError as exc:
            _log.warning("não consegui devolver a chave do ADB guardada (%s)", type(exc).__name__)
            return False
        _log.info("a chave do ADB estava ausente ou inválida; a cópia %s foi devolvida", chosen[:8])
        return True

    def back_up(self, expected: str) -> bool:
        """Guarda a chave de agora em `<resumo>/`, só se ainda é a `expected` (sem troca no meio).

        Seguro com vários processos ao mesmo tempo: escreve numa pasta provisória **própria** (pid
        e sufixo aleatório), confere o resumo da cópia e só a põe no lugar se o destino não existe
        (`os.rename` não substitui pasta cheia). Cópia que confere nunca é apagada nem substituída;
        uma que não confere (truncada) é posta de lado, não apagada. `True` se esta chamada gravou.
        """
        if self.fingerprint() != expected or expected in self.backups():
            return False
        target = self._backup / expected
        unique = f"{os.getpid()}-{secrets.token_hex(4)}"
        scratch = self._backup / f".novo-{expected}-{unique}"
        try:
            if not self._backup.is_dir():
                prepare_private_dir(self._backup)
            scratch.mkdir()
            for name in (KEY_FILE, PUBLIC_KEY_FILE):
                source = self._android / name
                if source.is_file():
                    shutil.copyfile(source, scratch / name)
            if key_fingerprint((scratch / KEY_FILE).read_bytes()) != expected:
                shutil.rmtree(scratch, ignore_errors=True)
                return False  # a chave mudou durante a cópia
            if target.exists():
                if expected in self.backups():
                    shutil.rmtree(scratch, ignore_errors=True)
                    return False  # outro processo já guardou uma cópia que confere
                os.replace(target, self._backup / f".ruim-{expected}-{unique}")
            os.rename(scratch, target)
        except (OSError, TvPairingError) as exc:
            shutil.rmtree(scratch, ignore_errors=True)
            # Perder a corrida para outro processo não é falha: a cópia dele já confere.
            return False if expected in self.backups() else self._warn_backup(exc)
        return True

    @staticmethod
    def _warn_backup(exc: BaseException) -> bool:
        _log.warning("não consegui guardar a chave do ADB (%s)", type(exc).__name__)
        return False


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _stamp(path: Path) -> tuple[int, int]:
    """Horário de modificação e tamanho do arquivo (`(0, 0)` se não existe)."""
    try:
        info = path.stat()
    except OSError:
        return (0, 0)
    return (info.st_mtime_ns, info.st_size)


class AdbAuthorization:
    """Estado gravado da permissão do ADB de uma TV e a regra de quando o agente pode conectar."""

    def __init__(
        self,
        state_dir: Path,
        keys: AdbKeys,
        endpoint: str,
        *,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._path = state_dir / STATE_FILE
        self._keys = keys
        self._endpoint = endpoint
        self._wall_clock = wall_clock
        self._record = self._load()
        self._stamp = _stamp(self._path)
        # Uma mudança que não chegou ao disco (gravação falhou): se outro processo gravar depois, a
        # releitura a descarta, e isso precisa aparecer no log.
        self._pending: AdbAuthRecord | None = None

    def _sync(self) -> None:
        """Relê o arquivo se outro processo (o `tv-volume`, outro agente) o gravou depois.

        O agente e a linha de comando guardam cópias em memória e gravam o registro inteiro: sem
        isto, um `needs_user` gravado por um deles seria ignorado e depois sobrescrito pelo outro.
        """
        stamp = _stamp(self._path)
        if stamp != self._stamp:
            pending, self._pending = self._pending, None
            self._record = self._load()
            self._stamp = stamp
            if pending is not None:
                self._reconcile(pending)

    def _reconcile(self, pending: AdbAuthRecord) -> None:
        """Uma mudança que não chegou ao disco e outro processo gravou depois: **a mais restritiva
        vence**. Um `needs_user` pendente é reaplicado por cima do que foi relido (senão um
        `verified` antigo voltaria a liberar conexão sozinha depois de a TV pedir o aviso de novo);
        qualquer outra mudança pendente é descartada, com aviso no log."""
        if pending.state == NEEDS_USER and self._record.state != NEEDS_USER:
            _log.warning(
                "outro processo gravou o estado da permissão do ADB; "
                "a recusa da TV que não chegou ao disco foi reaplicada"
            )
            self._save(_replace(self._record, state=NEEDS_USER, serial=""))
        else:
            _log.warning(
                "outro processo gravou o estado da permissão do ADB; "
                "a mudança que não chegou ao disco foi descartada"
            )

    @property
    def record(self) -> AdbAuthRecord:
        self._sync()
        return self._record

    @property
    def keys(self) -> AdbKeys:
        return self._keys

    def snapshot_key(self) -> str | None:
        """A chave de agora, para comparar depois: tirada **antes** de conectar."""
        self.prepare()
        return self._keys.fingerprint()

    def verified_for(self, mac: str | None) -> bool:
        """A TV deu e provou a permissão a esta chave, a este endereço e a este aparelho?"""
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state == VERIFIED
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
            and bool(mac)
            and mac == record.mac
        )

    def keeps_channel(self, mac: str | None) -> bool:
        """O canal ADB pode ficar aberto (hibernação, fim de pedido)?

        Só com a permissão provada **e** o vencimento de 7 dias desligado: se a TV ainda pode
        revogar a chave por falta de uso, ou se a recusou três vezes, um canal aberto seria religado
        pelo servidor do `adb` depois da revogação, e a religação mostraria o aviso sozinha.
        """
        return self.verified_for(mac) and self._record.timeout_disabled

    def granted_for(self, mac: str | None) -> bool:
        """A TV já aceitou (`granted`) esta chave neste endereço, e o aparelho não é outro?

        Uma conexão **nova** que chega a `device` sem aviso depois disso já é a prova (a que o
        toque faria desconectando e conectando de novo).
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state == GRANTED
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
            and (not mac or not record.mac or record.mac == mac)
        )

    def proven_for(self, mac: str | None) -> bool:
        """A prova já foi feita para esta chave, este endereço e o que se sabe do aparelho?

        Diferente de `verified_for` (que libera conexão automática e exige MAC): um MAC que não se
        leu agora (`""`, ARP vazia num toque) é **desconhecido**, nunca "outra TV": não invalida a
        prova nem se refaz a cada toque. Só um MAC lido e diferente do anotado é outro aparelho; e
        um registro sem MAC diante de um MAC lido pede a prova de novo, uma vez, para aprendê-lo.
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        mac_ok = not mac or (record.mac != "" and record.mac == mac)
        return (
            record.state == VERIFIED
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
            and mac_ok
        )

    def endpoint_moved(self) -> bool:
        """Há um registro de permissão para **outro** endereço (a TV pode ter trocado de IP)?"""
        self._sync()
        return bool(self._record.endpoint) and self._record.endpoint != self._endpoint

    def can_adopt(self) -> bool:
        """Vale a pena ler o MAC para levar o registro ao endereço de agora?

        Só com uma permissão dada, a mesma chave e um MAC anotado: sem isso `adopt_endpoint` nunca
        adotaria, e a sondagem de rede (até 1,5 s com a TV desligada) seria custo sem resposta.
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            bool(record.endpoint)
            and record.endpoint != self._endpoint
            and record.state in (GRANTED, VERIFIED)
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and bool(record.mac)
        )

    def another_device_at(self, mac: str | None) -> bool:
        """Com uma permissão dada, o MAC lido agora é de **outro** aparelho que não o anotado?

        Dois MACs lidos e diferentes. MAC vazio de qualquer lado é desconhecido, nunca "outro".
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state in (GRANTED, VERIFIED)
            # Com outra chave a permissão anotada não vale: a TV pediria o aviso de novo.
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and bool(record.mac)
            and bool(mac)
            and mac != record.mac
        )

    def rebind(self, mac: str) -> str:
        """A **pessoa** disse que o aparelho do endereço agora é a mesma TV: o registro passa a ele.

        É a saída do bloqueio "outro aparelho no endereço" (a TV trocou de Wi-Fi para cabo e o MAC
        mudou). Nunca é automático: só o comando explícito do app chega aqui. A permissão dada
        volta a `granted` (sem prova: o pedido da pessoa que vem a seguir a refaz, e a TV mostra o
        aviso se não confia na chave); serial e ajuste do vencimento são do aparelho antigo e se
        refazem. Sem MAC lido não há o que registrar (`REBIND_NO_MAC`). Se a chave `adbkey` de agora
        não é a do registro (`REBIND_KEY_CHANGED`), **nada é concedido**: a permissão era de outra
        chave, então estado e chave anotados ficam como estavam (só o endereço e o MAC passam ao
        aparelho de agora) e o pedido seguinte da pessoa é quem pede a permissão à chave nova.
        """
        if not mac:
            return REBIND_NO_MAC
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        had_grant = record.state in (GRANTED, VERIFIED)
        if had_grant and (fingerprint is None or fingerprint != record.fingerprint):
            self._save(_replace(record, endpoint=self._endpoint, mac=mac))
            return REBIND_KEY_CHANGED
        self._save(
            AdbAuthRecord(
                state=GRANTED if had_grant else record.state,
                fingerprint=record.fingerprint,
                endpoint=self._endpoint,
                mac=mac,
                granted_at=record.granted_at,
            )
        )
        return REBIND_DONE

    def clear(self) -> None:
        """Esquece o registro da TV (pareamento novo): o próximo pedido da pessoa começa do zero."""
        self._sync()
        self._save(AdbAuthRecord())

    def adopt_endpoint(self, mac: str | None) -> bool:
        """A mesma TV mudou de IP: leva o registro para o endereço de agora, sem falar com ela.

        O roteador reatribui o IP depois de uma queda de luz, mas a permissão do ADB é da **chave**
        na TV, não do endereço. O que identifica o aparelho é o MAC: só com o registro de uma
        permissão dada, a mesma chave e **dois MACs lidos e iguais** o endereço novo herda tudo
        (serial, ajuste do vencimento, prova). MAC vazio de qualquer lado, ou diferente, nunca
        adota: outro aparelho no endereço novo (ou antigo) continua barrado.
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        if (
            not record.endpoint
            or record.endpoint == self._endpoint
            or record.state not in (GRANTED, VERIFIED)
            or fingerprint is None
            or fingerprint != record.fingerprint
            or not mac
            or not record.mac
            or mac != record.mac
        ):
            return False
        self._save(_replace(record, endpoint=self._endpoint))
        _log.info(
            "a TV mudou de endereço, mas é o mesmo aparelho (MAC): a permissão do ADB foi mantida"
        )
        return True

    def gate_reason(self, mac: str | None = None) -> str:  # noqa: PLR0911 - uma saída por motivo
        """Por que o agente não conecta sozinho agora (um motivo curto e fixo, para o diagnóstico).

        Só lê o registro: não fala com a TV. `mac` é o lido agora (`None`: não lido).
        """
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        if record.state == _NONE:
            return GATE_NEVER
        if fingerprint is None or fingerprint != record.fingerprint:
            return GATE_KEY_CHANGED
        if record.state == NEEDS_USER:
            return GATE_TV_REFUSED
        if self.another_device_at(mac):
            return GATE_DEVICE_CHANGED
        if record.endpoint != self._endpoint:
            # MAC `""` (lido e vazio): a ARP não o mostra, então não há como confirmar a mesma TV.
            return GATE_MAC_UNKNOWN if mac == "" else GATE_ADDRESS_CHANGED
        if record.state == GRANTED:
            return GATE_UNPROVEN
        if record.state == VERIFIED and (not mac or not record.mac):
            return GATE_MAC_UNKNOWN
        return GATE_OTHER

    def forget_device(self) -> None:
        """O aparelho que responde não é o anotado: esquece serial e ajuste e exige nova prova.

        Não marca recusa da TV (`needs_user` só vem de uma recusa dela): o registro cai para
        `granted`, e o toque da pessoa o prova de novo e anota a identidade nova.
        """
        self._sync()
        record = self._record
        state = GRANTED if record.state == VERIFIED else record.state
        self._save(
            _replace(record, state=state, serial="", timeout_disabled=False, timeout_attempts=0)
        )

    def key_and_endpoint_match(self) -> bool:
        """A chave e o endereço de agora são os do registro (o aparelho se confere à parte)?"""
        self.prepare()  # uma chave que sumiu volta antes de se comparar
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state == VERIFIED
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
        )

    def has_grant(self) -> bool:
        """A TV aceitou esta chave neste endereço (provada ou ainda não)?"""
        self._sync()
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state in (GRANTED, VERIFIED)
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
        )

    def timeout_step_pending(self) -> bool:
        self._sync()
        record = self._record
        return not record.timeout_disabled and record.timeout_attempts < MAX_TIMEOUT_ATTEMPTS

    def prepare(self) -> None:
        """Antes de qualquer chamada ao `adb`: a cópia da chave registrada volta se ela sumiu."""
        self._keys.restore_if_missing(self.record.fingerprint or None)

    def mark_granted(self, snapshot: str | None, mac: str | None) -> bool:
        """A TV aceitou: registra `granted`, sem provar. Recusa chave mudada."""
        return self._record_grant(GRANTED, snapshot, mac)

    def mark_verified(self, snapshot: str | None, mac: str | None) -> bool:
        """Conexão nova, pedida pela pessoa, atendida sem aviso: a permissão ficou gravada."""
        return self._record_grant(VERIFIED, snapshot, mac)

    def _record_grant(self, state: str, snapshot: str | None, mac: str | None) -> bool:
        current = self._keys.fingerprint()
        if snapshot is None or current != snapshot:
            # A chave mudou (ou sumiu) entre o início e o fim da conexão: não se sabe a quem a TV
            # deu a permissão, e a cópia guardada seria a chave errada.
            _log.info("a chave do ADB mudou durante o pedido; a permissão não foi registrada")
            return False
        if not mac:
            _log.warning(
                "a TV não tem MAC na tabela ARP agora; a permissão não vai liberar conexão sozinha"
            )
        self._sync()
        record = self._record
        # Um MAC vazio de qualquer lado é desconhecido, não outra TV: só dois MACs lidos e
        # diferentes são aparelhos diferentes (e uma leitura vazia nunca apaga um MAC lido).
        same_tv = (
            record.fingerprint == snapshot
            and record.endpoint == self._endpoint
            and (not mac or not record.mac or record.mac == mac)
        )
        # Depois de `needs_user` (reset de fábrica, revogação) o ajuste que se fez na TV não vale
        # mais: ela volta ao padrão de 7 dias. `granted` para `verified` é o mesmo grant e mantém.
        carried = same_tv and record.state in (GRANTED, VERIFIED)
        if record.state == VERIFIED and same_tv and state == GRANTED:
            return True  # uma leitura de `device` não rebaixa o que já foi provado
        now = self._wall_clock()
        self._save(
            AdbAuthRecord(
                state=state,
                fingerprint=snapshot,
                endpoint=self._endpoint,
                mac=(mac or record.mac) if same_tv else (mac or ""),
                serial=record.serial if same_tv else "",
                # Outra chave ou outra TV não herda o que se fez na TV anterior.
                timeout_disabled=record.timeout_disabled if carried else False,
                timeout_attempts=record.timeout_attempts if carried else 0,
                granted_at=record.granted_at if same_tv and record.granted_at else now,
                last_handshake_at=now,
            )
        )
        self._keys.back_up(snapshot)
        return True

    def mark_needs_permission(self) -> None:
        """A TV pediu o aviso de novo: nenhuma conexão sozinha até um pedido da pessoa."""
        self._sync()
        if self._record.state != NEEDS_USER:
            # O serial se lê de novo na próxima prova (depois de um reset o aparelho costuma ser o
            # mesmo, mas a leitura é o que confere isso) e o passo do vencimento recomeça junto.
            self._save(_replace(self._record, state=NEEDS_USER, serial=""))

    def mark_timeout_disabled(self) -> None:
        self._sync()
        self._save(_replace(self._record, timeout_disabled=True))

    def note_timeout_attempt(self) -> None:
        self._sync()
        self._save(_replace(self._record, timeout_attempts=self._record.timeout_attempts + 1))

    def note_serial(self, serial: str) -> None:
        self._sync()
        if serial != self._record.serial:
            self._save(_replace(self._record, serial=serial))

    def _load(self) -> AdbAuthRecord:
        try:
            raw: Any = json.loads(self._path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            return AdbAuthRecord()
        if not isinstance(raw, dict):
            return AdbAuthRecord()
        defaults = AdbAuthRecord()
        try:
            state = str(raw.get("state", defaults.state))
            return AdbAuthRecord(
                state=state if state in _STATES else _NONE,
                fingerprint=str(raw.get("fingerprint", ""))[:FINGERPRINT_LENGTH],
                endpoint=str(raw.get("endpoint", ""))[:64],
                mac=str(raw.get("mac", ""))[:32],
                serial=str(raw.get("serial", ""))[:64],
                timeout_disabled=raw.get("timeout_disabled") is True,
                timeout_attempts=min(
                    MAX_TIMEOUT_ATTEMPTS, max(0, int(raw.get("timeout_attempts", 0)))
                ),
                granted_at=_finite(raw.get("granted_at", 0.0)),
                last_handshake_at=_finite(raw.get("last_handshake_at", 0.0)),
            )
        except TypeError, ValueError, OverflowError:
            # Arquivo corrompido (`1e400`, `Infinity`): recomeça sem permissão, sem derrubar o app.
            return defaults

    def _save(self, record: AdbAuthRecord) -> None:
        self._record = record
        # Nome próprio por gravação: o agente e o `tv-volume` podem gravar o mesmo arquivo juntos.
        temporary = self._path.with_name(
            f"{self._path.name}.{os.getpid()}-{secrets.token_hex(4)}.tmp"
        )
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(asdict(record)), encoding="utf-8")
            _replace_file(temporary, self._path)
            self._stamp = _stamp(self._path)
            self._pending = None
        except OSError as exc:
            self._pending = record
            temporary.unlink(missing_ok=True)  # a troca falhou: não deixa o `.tmp` para trás
            # Sem disco o estado fica só na memória: o agente segue, mas não lembra ao reiniciar.
            _log.warning(
                "não consegui gravar o estado da permissão do ADB (%s)", type(exc).__name__
            )


def _in_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _replace_file(source: Path, target: Path) -> None:
    """`os.replace` com poucas tentativas: no Windows, um antivírus ou o indexador segurando o
    arquivo por um instante faz a troca falhar com `PermissionError` e logo passar.

    Dentro do laço de eventos **nunca dorme** (travaria o agente todo): as tentativas seguem sem
    pausa. Fora dele (linha de comando) há uma pausa curta entre elas."""
    pause = not _in_event_loop()
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(source, target)
        except PermissionError:
            if attempt == _REPLACE_ATTEMPTS - 1:
                raise
            if pause:
                time.sleep(0.02 * (attempt + 1))
        else:
            return


def _finite(value: Any) -> float:
    number = float(value)
    return number if math.isfinite(number) else 0.0


def _replace(record: AdbAuthRecord, **changes: Any) -> AdbAuthRecord:
    return AdbAuthRecord(**{**asdict(record), **changes})
