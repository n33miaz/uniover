"""Cofre falso do ensaio de atualização: entrega um token de mentira e nunca toca o cofre real.

O ensaio aponta `PYTHON_KEYRING_BACKEND` para esta classe; assim o agente do ensaio acha o token
dele sem abrir o Cofre de Credenciais do Windows.
"""

from keyring.backend import KeyringBackend

SERVICE = "uniover-agent"
TOKEN = "drill-token-falso"  # noqa: S105 - token de mentira do ensaio


class DrillKeyring(KeyringBackend):
    priority = 1  # type: ignore[assignment]

    def get_password(self, service: str, username: str) -> str | None:
        return TOKEN if service == SERVICE else None

    def set_password(self, service: str, username: str, password: str) -> None:
        return None

    def delete_password(self, service: str, username: str) -> None:
        return None
