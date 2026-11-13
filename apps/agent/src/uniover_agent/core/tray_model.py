"""O que o ícone da bandeja mostra: estado, selo de atenção, texto e menu. Lógica pura, sem Windows.

A cor do disco diz como o agente está (conectado, reconectando, com erro, atualizando); o selo de
atenção é independente da cor e só aparece quando algo pede olhar (hoje, uma atualização que
falhou). Assim um agente conectado que não conseguiu se atualizar continua verde, mas com o selo.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal

from uniover_agent.core.net_status import NetProblem
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
# Uma queda mais curta que isto não ganha motivo: um tropeço de DNS não vira "sem internet".
NET_PROBLEM_AFTER: Final = timedelta(seconds=60)
# Motivo da queda, curto (cabe na legenda do ícone, cortada em 63 caracteres, e na linha de estado
# do menu). A cor do ícone continua a do estado: só o texto fica mais preciso.
_PROBLEM_TEXT: Final[dict[NetProblem, str]] = {
    "no_internet": "sem internet em casa",
    "api_down": "servidor fora do ar",
    "no_network": "PC sem rede",
}
# O que fazer, em português simples (menu e item "Status").
_PROBLEM_HINT: Final[dict[NetProblem, str]] = {
    "no_internet": (
        "A internet de casa caiu. Para o celular voltar a controlar já, ligue-o ao PC por cabo "
        "USB e ative o compartilhamento de internet, sem tirar o PC do Wi-Fi de casa."
    ),
    "api_down": (
        "A internet funciona, mas o servidor do UniOver não respondeu. O agente volta sozinho "
        "quando ele voltar."
    ),
    "no_network": (
        "Este PC não está em nenhuma rede. Confira o Wi-Fi ou o cabo e se o roteador está ligado."
    ),
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
    # Por que o agente não alcança a API, segundo ele mesmo (nulo quando não se sabe).
    net_problem: NetProblem | None = None


@dataclass(frozen=True, slots=True)
class TrayView:
    state: TrayState
    attention: bool
    title: str
    # Motivo da queda, só quando sem conexão há algum tempo e o agente soube dizer.
    problem: NetProblem | None = None

    @property
    def status_text(self) -> str:
        """A linha de estado do menu: o motivo da queda, quando há, no lugar do estado."""
        text = _PROBLEM_TEXT[self.problem] if self.problem else _STATE_TEXT[self.state]
        return text[:1].upper() + text[1:]

    @property
    def hint(self) -> str:
        """O que fazer com a queda (vazio quando não há motivo conhecido)."""
        return _PROBLEM_HINT[self.problem] if self.problem else ""

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


def net_problem(state: TrayState, inputs: TrayInputs) -> NetProblem | None:
    """O motivo vale só para "reconectando" ou "sem conexão", e depois de um minuto de queda."""
    if state not in {"reconnecting", "error"} or inputs.net_problem is None:
        return None
    if inputs.since is None or inputs.now - inputs.since < NET_PROBLEM_AFTER:
        return None
    return inputs.net_problem


def tooltip(
    state: TrayState, attention: bool, inputs: TrayInputs, problem: NetProblem | None = None
) -> str:
    """Texto do balãozinho ao parar o mouse; o Windows corta em 127 caracteres, então fica curto."""
    text = f"UniOver: {_PROBLEM_TEXT[problem] if problem else _STATE_TEXT[state]}"
    if state == "connected":
        text += f" - {_tv_text(inputs)}"
    if attention:
        text += " - atenção: falha na atualização"
    return text[:TOOLTIP_LIMIT]


def view_of(inputs: TrayInputs) -> TrayView:
    state = decide_state(inputs)
    attention = needs_attention(inputs)
    problem = net_problem(state, inputs)
    return TrayView(state, attention, tooltip(state, attention, inputs, problem), problem)


def status_summary(view: TrayView, inputs: TrayInputs, version: str | None) -> str:
    """O que o item "Status" mostra: uma linha por assunto, sem dado pessoal."""
    lines = [f"Agente: {_PROBLEM_TEXT[view.problem] if view.problem else _STATE_TEXT[view.state]}"]
    if view.state == "connected":
        lines.append(f"TV: {_tv_text(inputs)}")
    if view.hint:
        lines.append(view.hint)
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
