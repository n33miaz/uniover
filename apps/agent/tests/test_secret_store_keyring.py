import keyring.errors
import pytest
from keyring.backend import KeyringBackend
from keyring.backends import chainer, fail

from uniover_agent.adapters.secret_store_keyring import (
    SERVICE,
    KeyringSecretStore,
    SecretStoreError,
)


class MemoryBackend(KeyringBackend):
    priority = 1

    def __init__(self) -> None:
        super().__init__()  # type: ignore[no-untyped-call]
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.data.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.data[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self.data:
            raise keyring.errors.PasswordDeleteError("nao existe")
        del self.data[(service, username)]


class PlainTextBackend(MemoryBackend):
    """Imita o `keyrings.alt` (arquivo em texto claro): só o módulo importa para a recusa."""


PlainTextBackend.__module__ = "keyrings.alt.file"


def test_roundtrip_uses_service_and_agent_id_as_name() -> None:
    backend = MemoryBackend()
    store = KeyringSecretStore(backend)
    assert store.get("pc-casa") is None
    store.set("pc-casa", "uo_dev_x")
    assert store.get("pc-casa") == "uo_dev_x"
    assert backend.data == {(SERVICE, "pc-casa"): "uo_dev_x"}
    store.delete("pc-casa")
    assert store.get("pc-casa") is None


def test_delete_of_missing_secret_is_silent() -> None:
    KeyringSecretStore(MemoryBackend()).delete("nao-existe")


def test_plain_text_backend_is_refused() -> None:
    with pytest.raises(SecretStoreError, match="texto claro"):
        KeyringSecretStore(PlainTextBackend())


def test_fail_backend_is_refused() -> None:
    with pytest.raises(SecretStoreError):
        KeyringSecretStore(fail.Keyring())  # type: ignore[no-untyped-call]


def test_chainer_picks_the_secure_leaf_over_plain_text() -> None:
    secure = MemoryBackend()

    class Combined(chainer.ChainerBackend):
        backends = [PlainTextBackend(), secure]  # noqa: RUF012

    store = KeyringSecretStore(Combined())  # type: ignore[no-untyped-call]
    store.set("a", "b")
    assert secure.data == {(SERVICE, "a"): "b"}


def test_backend_failure_does_not_leak_details() -> None:
    class Broken(MemoryBackend):
        def get_password(self, service: str, username: str) -> str | None:
            raise keyring.errors.KeyringError("detalhe interno com segredo")

    with pytest.raises(SecretStoreError) as caught:
        KeyringSecretStore(Broken()).get("x")
    assert "segredo" not in str(caught.value)
