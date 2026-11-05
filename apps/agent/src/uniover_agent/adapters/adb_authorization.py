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

import hashlib
import json
import logging
import os
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
# Tentativas, no total, de desligar o vencimento da permissão na TV: depois disso o agente fica
# com o contato periódico (que também zera a contagem de 7 dias).
MAX_TIMEOUT_ATTEMPTS: Final = 3
FINGERPRINT_LENGTH: Final = 16
GRANTED: Final = "granted"
VERIFIED: Final = "verified"
NEEDS_USER: Final = "needs_user"
_NONE: Final = ""
_STATES: Final = frozenset({_NONE, GRANTED, VERIFIED, NEEDS_USER})
_PEM_BEGIN: Final = b"-----BEGIN"
_PEM_END: Final = b"-----END"
MAC_PROBE_SECONDS: Final = 1.5


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
    cliente), então não mostra aviso. `None` se a TV não atende (desligada ou fora da rede).
    """
    if not await tcp_open(host, port, MAC_PROBE_SECONDS):
        return None
    return await arp_mac(host)


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
        except OSError as exc:
            _log.warning("não consegui devolver a chave do ADB guardada (%s)", type(exc).__name__)
            return False
        _log.info("a chave do ADB estava ausente ou inválida; a cópia %s foi devolvida", chosen[:8])
        return True

    def back_up(self, expected: str) -> bool:
        """Guarda a chave de agora em `<resumo>/`, só se ainda é a `expected` (sem troca no meio).

        Não sobrescreve cópia que já confere. Escreve numa pasta provisória, confere o resumo da
        cópia e só então a põe no lugar. `True` se gravou.
        """
        if self.fingerprint() != expected or expected in self.backups():
            return False
        target = self._backup / expected
        scratch = self._backup / f".novo-{expected}"
        try:
            if not self._backup.is_dir():
                prepare_private_dir(self._backup)
            shutil.rmtree(scratch, ignore_errors=True)
            scratch.mkdir()
            for name in (KEY_FILE, PUBLIC_KEY_FILE):
                source = self._android / name
                if source.is_file():
                    shutil.copyfile(source, scratch / name)
            if key_fingerprint((scratch / KEY_FILE).read_bytes()) != expected:
                shutil.rmtree(scratch, ignore_errors=True)
                return False  # a chave mudou durante a cópia
            shutil.rmtree(target, ignore_errors=True)  # cópia antiga que não conferia
            os.replace(scratch, target)
        except (OSError, TvPairingError) as exc:
            shutil.rmtree(scratch, ignore_errors=True)
            _log.warning("não consegui guardar a chave do ADB (%s)", type(exc).__name__)
            return False
        return True


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


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

    @property
    def record(self) -> AdbAuthRecord:
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

    def key_and_endpoint_match(self) -> bool:
        """A chave e o endereço de agora são os do registro (o aparelho se confere à parte)?"""
        self.prepare()  # uma chave que sumiu volta antes de se comparar
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
        record = self._record
        fingerprint = self._keys.fingerprint()
        return (
            record.state in (GRANTED, VERIFIED)
            and fingerprint is not None
            and fingerprint == record.fingerprint
            and record.endpoint == self._endpoint
        )

    def timeout_step_pending(self) -> bool:
        record = self._record
        return not record.timeout_disabled and record.timeout_attempts < MAX_TIMEOUT_ATTEMPTS

    def prepare(self) -> None:
        """Antes de qualquer chamada ao `adb`: a cópia da chave registrada volta se ela sumiu."""
        self._keys.restore_if_missing(self._record.fingerprint or None)

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
        record = self._record
        same_tv = (
            record.fingerprint == snapshot
            and record.endpoint == self._endpoint
            and record.mac == (mac or "")
        )
        if record.state == VERIFIED and same_tv and state == GRANTED:
            return True  # uma leitura de `device` não rebaixa o que já foi provado
        now = self._wall_clock()
        self._save(
            AdbAuthRecord(
                state=state,
                fingerprint=snapshot,
                endpoint=self._endpoint,
                mac=mac or "",
                serial=record.serial if same_tv else "",
                # Outra chave ou outra TV não herda o que se fez na TV anterior.
                timeout_disabled=record.timeout_disabled if same_tv else False,
                timeout_attempts=record.timeout_attempts if same_tv else 0,
                granted_at=record.granted_at if same_tv and record.granted_at else now,
                last_handshake_at=now,
            )
        )
        self._keys.back_up(snapshot)
        return True

    def mark_needs_permission(self) -> None:
        """A TV pediu o aviso de novo: nenhuma conexão sozinha até um pedido da pessoa."""
        if self._record.state != NEEDS_USER:
            self._save(_replace(self._record, state=NEEDS_USER))

    def mark_timeout_disabled(self) -> None:
        self._save(_replace(self._record, timeout_disabled=True))

    def note_timeout_attempt(self) -> None:
        self._save(_replace(self._record, timeout_attempts=self._record.timeout_attempts + 1))

    def note_serial(self, serial: str) -> None:
        if serial != self._record.serial:
            self._save(_replace(self._record, serial=serial))

    def touch_handshake(self) -> None:
        self._save(_replace(self._record, last_handshake_at=self._wall_clock()))

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
                timeout_attempts=max(0, int(raw.get("timeout_attempts", 0))),
                granted_at=float(raw.get("granted_at", 0.0)),
                last_handshake_at=float(raw.get("last_handshake_at", 0.0)),
            )
        except TypeError, ValueError:
            return defaults

    def _save(self, record: AdbAuthRecord) -> None:
        self._record = record
        temporary = self._path.with_name(self._path.name + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(asdict(record)), encoding="utf-8")
            os.replace(temporary, self._path)
        except OSError as exc:
            # Sem disco o estado fica só na memória: o agente segue, mas não lembra ao reiniciar.
            _log.warning(
                "não consegui gravar o estado da permissão do ADB (%s)", type(exc).__name__
            )


def _replace(record: AdbAuthRecord, **changes: Any) -> AdbAuthRecord:
    return AdbAuthRecord(**{**asdict(record), **changes})
