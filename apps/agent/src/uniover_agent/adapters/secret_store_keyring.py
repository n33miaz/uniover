"""Cofre de segredos sobre `keyring`: no Windows, o Cofre de Credenciais (Credential Manager)."""

from typing import Any

import keyring
import keyring.errors
from keyring.backend import KeyringBackend
from keyring.backends import chainer, fail

SERVICE = "uniover-agent"


class SecretStoreError(Exception):
    """O cofre não está disponível, não é seguro ou falhou ao ler/gravar."""


def _is_secure(backend: KeyringBackend) -> bool:
    module = type(backend).__module__
    # `keyrings.alt` guarda em arquivo de texto claro; `fail` e `null` não guardam nada.
    if module.startswith("keyrings.alt") or isinstance(backend, fail.Keyring):
        return False
    return not module.startswith("keyring.backends.null")


def _pick_backend(backend: KeyringBackend | None) -> KeyringBackend:
    candidate = backend or keyring.get_keyring()
    leaves: list[Any] = (
        list(candidate.backends) if isinstance(candidate, chainer.ChainerBackend) else [candidate]
    )
    for leaf in leaves:
        if _is_secure(leaf):
            return leaf  # type: ignore[no-any-return]
    raise SecretStoreError(
        "nenhum cofre de credenciais seguro disponível (o backend em texto claro é recusado); "
        "no Windows use o Cofre de Credenciais do próprio sistema"
    )


class KeyringSecretStore:
    """Guarda cada segredo no cofre do sistema, no serviço `uniover-agent`, pelo nome dado."""

    def __init__(self, backend: KeyringBackend | None = None, service: str = SERVICE) -> None:
        self._backend = _pick_backend(backend)
        self._service = service

    def get(self, name: str) -> str | None:
        try:
            return self._backend.get_password(self._service, name)
        except keyring.errors.KeyringError as exc:
            raise SecretStoreError(f"falha ao ler do cofre: {type(exc).__name__}") from None

    def set(self, name: str, value: str) -> None:
        try:
            self._backend.set_password(self._service, name, value)
        except keyring.errors.KeyringError as exc:
            raise SecretStoreError(f"falha ao gravar no cofre: {type(exc).__name__}") from None

    def delete(self, name: str) -> None:
        try:
            self._backend.delete_password(self._service, name)
        except keyring.errors.PasswordDeleteError:
            return  # já não existia
        except keyring.errors.KeyringError as exc:
            raise SecretStoreError(f"falha ao apagar do cofre: {type(exc).__name__}") from None
