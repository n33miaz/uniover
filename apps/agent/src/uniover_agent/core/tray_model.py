"""O que o ícone da bandeja mostra: estado, selo de atenção, texto e menu. Lógica pura, sem Windows.

A cor do disco diz como o agente está (conectado, reconectando, com erro, atualizando); o selo de
atenção é independente da cor e só aparece quando algo pede olhar (hoje, uma atualização que
falhou). Assim um agente conectado que não conseguiu se atualizar continua verde, mas com o selo.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal

from uniover_agent.core.update_report import UPDATING_STALE_AFTER

TrayState = Literal["connected", "reconnecting", "error", "updating"]
MenuAction = Literal["open", "status", "log", "update", "restart", "quit"]

# Desconectado há menos que isto é "reconectando" (queda de rede, API acordando); depois disso é
# erro.
RECONNECT_GRACE: Final = timedelta(minutes=3)
# O agente regrava o `last-alive` a cada minuto: sem sinal por tanto tempo, o processo parou ou
# travou.
HEARTBEAT_STALE: Final = timedelta(minutes=5)
# Resultados da atualização que pedem atenção do dono (o selo aparece enquanto valerem).
ATTENTION_OUTCOMES: Final = frozenset({"failed", "blocked", "rolled_back"})
# Só estes resultados abrem o balão do Windows: o resto é a rotina e não interrompe ninguém.
BALLOON_OUTCOMES: Final = frozenset({"failed", "rolled_back"})
# Uma falha mais velha que isto não vira balão num ícone que acabou de abrir.
BALLOON_FRESH_FOR: Final = timedelta(hours=24)
TOOLTIP_LIMIT: Final = 120

_STATE_TEXT: Final[dict[TrayState, str]] = {
    "connected": "conectado",
    "reconnecting": "reconectando",
    "error": "sem conexão",
    "updating": "atualizando",
}


@dataclass(frozen=True, slots=True)
class TrayInputs:
    """Tudo que a decisão precisa, já lido dos arquivos pequenos de `runtime`."""

    now: datetime
    connected: bool = False
    # Quando `connected` mudou pela última vez (nulo se ninguém soube dizer).
    since: datetime | None = None
    power: str = "unknown"
    tv_name: str = "TV"
    update_outcome: str = "not_checked"
    update_checked_at: datetime | None = None
    # Há quanto tempo o agente deu sinal de vida; nulo quando não há como saber.
    heartbeat_age: timedelta | None = None


@dataclass(frozen=True, slots=True)
class TrayView:
    state: TrayState
    attention: bool
    title: str

    @property
    def icon_file(self) -> str:
        """O `.ico` desta combinação (um por estado, com e sem o selo)."""
        return f"{self.state}-attention.ico" if self.attention else f"{self.state}.ico"


def _tv_text(inputs: TrayInputs) -> str:
    if inputs.power == "on":
        return f"{inputs.tv_name} ligada"
    if inputs.power == "off":
        return f"{inputs.tv_name} desligada"
    return inputs.tv_name


def decide_state(inputs: TrayInputs) -> TrayState:
    """Atualizando manda (o agente reinicia no meio); sem sinal de vida é erro mesmo se o arquivo
    diz "conectado"."""
    if inputs.update_outcome == "updating" and (
        inputs.update_checked_at is None
        or inputs.now - inputs.update_checked_at <= UPDATING_STALE_AFTER
    ):
        return "updating"
    if inputs.heartbeat_age is not None and inputs.heartbeat_age > HEARTBEAT_STALE:
        return "error"
    if inputs.connected:
        return "connected"
    if inputs.since is None or inputs.now - inputs.since <= RECONNECT_GRACE:
        return "reconnecting"
    return "error"


def needs_attention(inputs: TrayInputs) -> bool:
    return inputs.update_outcome in ATTENTION_OUTCOMES


def tooltip(state: TrayState, attention: bool, inputs: TrayInputs) -> str:
    """Texto do balãozinho ao parar o mouse; o Windows corta em 127 caracteres, então fica curto."""
    text = f"UniOver: {_STATE_TEXT[state]}"
    if state == "connected":
        text += f" - {_tv_text(inputs)}"
    if attention:
        text += " - atenção: falha na atualização"
    return text[:TOOLTIP_LIMIT]


def view_of(inputs: TrayInputs) -> TrayView:
    state = decide_state(inputs)
    attention = needs_attention(inputs)
    return TrayView(state, attention, tooltip(state, attention, inputs))


def status_summary(view: TrayView, inputs: TrayInputs, version: str | None) -> str:
    """O que o item "Status" mostra: uma linha por assunto, sem dado pessoal."""
    lines = [f"Agente: {_STATE_TEXT[view.state]}"]
    if view.state == "connected":
        lines.append(f"TV: {_tv_text(inputs)}")
    if view.attention:
        lines.append("Atualização: falhou; veja o registro")
    elif inputs.update_outcome == "updating":
        lines.append("Atualização: em andamento")
    if version:
        lines.append(f"Versão: {version[:12]}")
    return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class MenuEntry:
    action: MenuAction
    label: str
    default: bool = False


# `None` é um separador. O "Sair" só fecha o ícone: o agente segue (ver `adapters/tray.py`).
MENU: Final[tuple[MenuEntry | None, ...]] = (
    MenuEntry("open", "Abrir UniOver", default=True),
    MenuEntry("status", "Status"),
    MenuEntry("log", "Ver Registro"),
    None,
    MenuEntry("update", "Atualizar Agora"),
    MenuEntry("restart", "Reiniciar"),
    None,
    MenuEntry("quit", "Sair"),
)


def should_notify_update_failure(
    outcome: str, checked_at: datetime | None, last_notified: str | None, now: datetime
) -> bool:
    """Balão só numa falha nova: o mesmo resultado (mesmo `checked_at`) nunca avisa duas vezes."""
    if outcome not in BALLOON_OUTCOMES or checked_at is None:
        return False
    if now - checked_at > BALLOON_FRESH_FOR:
        return False
    return checked_at.isoformat() != last_notified
