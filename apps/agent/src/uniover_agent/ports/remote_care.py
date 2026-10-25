"""Portas da manutenção remota: o registro do próprio agente e os sinais ao supervisor."""

from dataclasses import dataclass
from typing import Protocol


class LogUnavailable(Exception):  # noqa: N818 - nome do domínio: "o registro não está disponível"
    """O agente não tem registro em arquivo para entregar (ou não conseguiu lê-lo)."""


class MaintenanceUnavailable(Exception):  # noqa: N818 - idem
    """O pedido não pôde ser entregue ao supervisor."""


class LogSource(Protocol):
    """Lê o fim do registro do próprio agente.

    O arquivo é fixo (decidido na configuração local): nada que chega pela rede escolhe o caminho.
    """

    def tail(self, lines: int) -> list[str]:
        """As últimas `lines` linhas inteiras, da mais antiga à mais nova (sem a quebra final)."""
        ...


class MaintenanceSignals(Protocol):
    """Pede ao supervisor do Windows que atualize ou reinicie o agente (sinais da bandeja)."""

    def request_update(self) -> None: ...

    def request_restart(self) -> None: ...

    def request_rollback(self) -> None: ...

    def previous_available(self) -> bool:
        """Há uma versão anterior guardada para voltar atrás?"""
        ...


@dataclass(frozen=True, slots=True)
class UpdateStatus:
    """O que a auto-atualização deixou para a tela do dono, limpo, dentro do contrato.

    `outcome`: `not_checked`, `updating`, `updated`, `up_to_date`, `failed`, `blocked` ou
    `rolled_back`. Os horários são UTC com sufixo `Z`; os `sha` são o commit inteiro (40 hexa).
    """

    outcome: str = "not_checked"
    installed_sha: str | None = None
    installed_at: str | None = None
    latest_sha: str | None = None
    checked_at: str | None = None
    next_check_at: str | None = None
    reason: str | None = None
    blocked_sha: str | None = None
    # Commit da pasta `app.previous` (a versão que a última atualização guardou para voltar atrás).
    previous_sha: str | None = None
    rolled_back: bool = False


class UpdateStatusSource(Protocol):
    """O estado da auto-atualização (arquivo em `runtime`, escrito por quem atualiza)."""

    def read(self) -> UpdateStatus:
        """Nunca levanta: arquivo ausente ou adulterado vira `not_checked` sem os campos ruins."""
        ...
