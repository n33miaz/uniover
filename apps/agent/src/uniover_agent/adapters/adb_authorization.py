"""Permissão do ADB na TV: a chave do PC, o que se sabe dela e uma cópia que atualização não toca.

O agente usa o `adb` do PC, e quem assina a conexão é o servidor dele, com a chave `adbkey` da pasta
`.android` do usuário (o `adb` do Windows não deixa mudar essa pasta por variável de ambiente, e
o aviso da TV sempre oferece essa chave).
Então aqui a chave não é trocada, e sim **guardada e vigiada**:

* uma cópia (`adbkey` e `adbkey.pub`) fica numa pasta restrita ao usuário, dentro da pasta de
  instalação, que nem a atualização nem a reinstalação apagam. Se o `adbkey` sumir, a cópia volta
  **antes** de qualquer chamada ao `adb` (senão ele gera uma chave nova e a TV pergunta de novo);
* uma chave existente e diferente da guardada **nunca** é sobrescrita (é do usuário, e o Android
  Studio a usa também): só se registra que a permissão da TV deixou de valer para ela;
* por TV, um arquivo diz se a TV já deu a permissão a esta chave. Enquanto não deu, o agente não
  abre conexão nova sozinho (cada uma faria a TV mostrar o aviso "Permitir depuração USB" de
  novo): só um pedido explícito da pessoa conecta.

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

from uniover_agent.adapters.tv_pairing import TvPairingError, prepare_private_dir

_log = logging.getLogger(__name__)

KEY_FILE: Final = "adbkey"
PUBLIC_KEY_FILE: Final = "adbkey.pub"
STATE_FILE: Final = "adb-authorization.json"
# Tentativas, no total, de desligar o vencimento da permissão na TV: depois disso o agente fica
# com o contato periódico (que também zera a contagem de 7 dias).
MAX_TIMEOUT_ATTEMPTS: Final = 3
_FINGERPRINT_LENGTH: Final = 16


def default_android_dir() -> Path:
    """A pasta `.android` do usuário, onde o `adb` guarda a chave."""
    return Path.home() / ".android"


@dataclass(frozen=True, slots=True)
class AdbAuthRecord:
    """O que se sabe sobre a permissão desta TV: gravado em disco, sem nada secreto."""

    fingerprint: str = ""
    authorized: bool = False
    timeout_disabled: bool = False
    timeout_attempts: int = 0
    authorized_at: float = 0.0
    last_handshake_at: float = 0.0


class AdbKeys:
    """A chave do `adb` do usuário e a cópia guardada na pasta de instalação."""

    def __init__(self, backup_dir: Path, android_dir: Path | None = None) -> None:
        self._backup = backup_dir
        self._android = android_dir if android_dir is not None else default_android_dir()

    @property
    def key_path(self) -> Path:
        return self._android / KEY_FILE

    def fingerprint(self) -> str | None:
        """Resumo curto da chave em uso, ou `None` se ainda não existe."""
        try:
            data = self.key_path.read_bytes()
        except OSError:
            return None
        return hashlib.sha256(data).hexdigest()[:_FINGERPRINT_LENGTH] if data else None

    def restore_if_missing(self) -> bool:
        """Devolve a cópia guardada se o `adbkey` sumiu. Nunca sobrescreve uma chave que existe."""
        if self.key_path.exists() or not (self._backup / KEY_FILE).is_file():
            return False
        try:
            self._android.mkdir(parents=True, exist_ok=True)
            for name in (KEY_FILE, PUBLIC_KEY_FILE):
                source = self._backup / name
                if source.is_file():
                    shutil.copyfile(source, self._android / name)
        except OSError as exc:
            _log.warning("não consegui devolver a chave do ADB guardada (%s)", type(exc).__name__)
            return False
        _log.info("a chave do ADB tinha sumido; a cópia guardada foi devolvida")
        return True

    def back_up(self) -> bool:
        """Guarda a chave em uso (se a cópia falta ou é outra). `True` se gravou."""
        current = self.fingerprint()
        if current is None or self._backup_fingerprint() == current:
            return False
        try:
            if not self._backup.is_dir():
                prepare_private_dir(self._backup)
            for name in (KEY_FILE, PUBLIC_KEY_FILE):
                source = self._android / name
                if source.is_file():
                    shutil.copyfile(source, self._backup / name)
        except (OSError, TvPairingError) as exc:
            _log.warning("não consegui guardar a chave do ADB (%s)", type(exc).__name__)
            return False
        return True

    def _backup_fingerprint(self) -> str | None:
        try:
            data = (self._backup / KEY_FILE).read_bytes()
        except OSError:
            return None
        return hashlib.sha256(data).hexdigest()[:_FINGERPRINT_LENGTH] if data else None


class AdbAuthorization:
    """Estado gravado da permissão do ADB de uma TV e a regra de quando o agente pode conectar."""

    def __init__(
        self,
        state_dir: Path,
        keys: AdbKeys,
        *,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._path = state_dir / STATE_FILE
        self._keys = keys
        self._wall_clock = wall_clock
        self._record = self._load()

    @property
    def record(self) -> AdbAuthRecord:
        return self._record

    @property
    def keys(self) -> AdbKeys:
        return self._keys

    def allows_automatic_connect(self) -> bool:
        """O agente pode conectar sem pedido? Só se a TV já deu a permissão a esta chave."""
        self.prepare()  # uma chave que sumiu volta antes de se comparar
        fingerprint = self._keys.fingerprint()
        return (
            self._record.authorized
            and fingerprint is not None
            and fingerprint == self._record.fingerprint
        )

    def timeout_step_pending(self) -> bool:
        record = self._record
        return not record.timeout_disabled and record.timeout_attempts < MAX_TIMEOUT_ATTEMPTS

    def prepare(self) -> None:
        """Antes de qualquer chamada ao `adb`: a chave guardada volta se o `adbkey` sumiu."""
        self._keys.restore_if_missing()

    def mark_authorized(self) -> None:
        fingerprint = self._keys.fingerprint() or self._record.fingerprint
        changed = fingerprint != self._record.fingerprint
        if self._record.authorized and not changed:
            return
        now = self._wall_clock()
        self._save(
            AdbAuthRecord(
                fingerprint=fingerprint,
                authorized=True,
                # Outra chave não herda o que se fez na TV para a anterior.
                timeout_disabled=False if changed else self._record.timeout_disabled,
                timeout_attempts=0 if changed else self._record.timeout_attempts,
                authorized_at=now,
                last_handshake_at=now,
            )
        )
        self._keys.back_up()

    def mark_needs_permission(self) -> None:
        if self._record.authorized:
            self._save(_replace(self._record, authorized=False))

    def mark_timeout_disabled(self) -> None:
        self._save(_replace(self._record, timeout_disabled=True))

    def note_timeout_attempt(self) -> None:
        self._save(_replace(self._record, timeout_attempts=self._record.timeout_attempts + 1))

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
            return AdbAuthRecord(
                fingerprint=str(raw.get("fingerprint", defaults.fingerprint))[:_FINGERPRINT_LENGTH],
                authorized=raw.get("authorized") is True,
                timeout_disabled=raw.get("timeout_disabled") is True,
                timeout_attempts=max(0, int(raw.get("timeout_attempts", 0))),
                authorized_at=float(raw.get("authorized_at", 0.0)),
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
