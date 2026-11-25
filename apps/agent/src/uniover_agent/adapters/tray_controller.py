r"""O comportamento do ícone da bandeja, sem Windows nem pystray: o que cada item do menu faz e
quando avisar.

`adapters/tray.py` liga isto ao pystray; os testes ligam a fakes. Regras que moram aqui:

- "Sair" só fecha o ícone. Deixa `runtime\tray-closed` (para o supervisor não o reabrir sozinho) e
  para o ícone; o agente não é tocado. O ícone volta pelo atalho "UniOver Agente" do menu Iniciar ou
  no próximo logon.
- Sozinho, o balão do Windows só aparece em dois casos: numa falha de atualização, uma vez por
  resultado (a lembrança fica em `runtime\tray-notified.json`, então reabrir o ícone não repete o
  aviso), e quando um aparelho começa a ver a tela do PC.
- "Parar de mostrar a tela" pede o fim da visualização que o menu mostrava, nunca de outra.
- Qualquer erro do próprio ícone vira ocorrência de diagnóstico (componente `tray`), que o agente
  envia à API.
"""

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Final

from uniover_agent.core.diagnostics import describe_exception
from uniover_agent.core.tray_model import (
    VIEWING_RESUMES_WITHIN,
    TrayInputs,
    TrayView,
    should_notify_update_failure,
    status_summary,
    view_of,
)
from uniover_agent.core.tray_promotion import PromotionResult, promote_once
from uniover_agent.ports.diagnostics import Severity
from uniover_agent.ports.tray import NotifyIconSettings, PromotionMarker

_log = logging.getLogger(__name__)

CLOSED_FLAG: Final = "tray-closed"
NOTIFIED_FILE: Final = "tray-notified.json"
TITLE: Final = "UniOver"
VIEWING_TITLE: Final = "Tela do PC"
VIEWING_MESSAGE: Final = (
    "Um aparelho está vendo a tela deste PC. Para encerrar, use "
    '"Parar de mostrar a tela" no ícone do UniOver.'
)
PROMOTE_EVERY_SECONDS: Final = 3.0
PROMOTE_FOR_SECONDS: Final = 120.0

Record = Callable[[str, Severity, str], None]


@dataclass(slots=True)
class TrayEnv:
    """O que o controlador pede ao mundo de fora (cada peça é trocada por um falso nos testes)."""

    base: Path
    now: Callable[[], datetime]
    read_inputs: Callable[[datetime], TrayInputs]
    open_url: Callable[[str], None]
    open_file: Callable[[Path], None]
    # Devolve se o aviso foi entregue (sem ícone na bandeja ainda, não há como mostrar balão).
    notify: Callable[[str, str], bool]
    stop: Callable[[], None]
    # Pede o fim daquela visualização da tela; `False` se ela já tinha acabado.
    stop_screen: Callable[[str], bool]
    record: Callable[[str, Severity, str], None]
    site_url: str
    version: Callable[[], str | None] = lambda: None


class TrayController:
    def __init__(self, env: TrayEnv) -> None:
        self._env = env
        self.view: TrayView | None = None
        self.inputs: TrayInputs | None = None
        # O último aviso dado nesta execução: vale mesmo se o disco não deixar gravar a lembrança.
        self._announced: str | None = None
        # Quando a visualização já avisada foi vista pela última vez (nulo: a próxima é nova).
        self._viewing_seen: datetime | None = None
        # O identificador da última sessão notificada ou emendada (some junto com `_viewing_seen`).
        self._viewing_session: str | None = None
        # A que o dono mandou parar: segue visível até o processo da tela sair.
        self._stopped_screen: str | None = None

    # -- sinais para o supervisor
    # ------------------------------------------------------------------------

    def _signal(self, name: str) -> None:
        runtime = self._env.base / "runtime"
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / name).touch()

    # -- itens do menu
    # ------------------------------------------------------------------------------------

    def handle(self, action: str, screen_session: str | None = None) -> None:
        """Executa um item do menu. Falha de um item vira diagnóstico e nunca derruba o ícone.

        `screen_session` é a visualização que o menu mostrava quando "Parar de mostrar a tela" foi
        escolhido."""
        try:
            self._dispatch(action, screen_session)
        except Exception as exc:
            _log.warning("item do menu da bandeja falhou (%s)", action, exc_info=True)
            self._env.record("tray.action_failed", "error", f"{action}: {describe_exception(exc)}")

    def _dispatch(self, action: str, screen_session: str | None) -> None:
        env = self._env
        if action == "stop_screen":
            if screen_session and env.stop_screen(screen_session):
                self._stopped_screen = screen_session
                # O aparelho que pedir a tela de novo começa outra visualização, com aviso.
                self._viewing_seen = None
                self._viewing_session = None
        elif action == "open":
            env.open_url(env.site_url)
        elif action == "status":
            self.refresh()
            if self.view is not None and self.inputs is not None:
                env.notify(status_summary(self.view, self.inputs, env.version()), TITLE)
        elif action == "log":
            path = env.base / "logs" / "agent.log"
            if path.exists():
                env.open_file(path)
            else:
                env.notify("Ainda não há registro para mostrar.", TITLE)
        elif action == "update":
            # Sem balão: quem pediu já sabe.
            self._signal("update-now")
        elif action == "restart":
            self._signal("restart-now")
        elif action == "quit":
            # Só o ícone fecha: o agente e o supervisor seguem. Sem o sinal, o supervisor abriria o
            # ícone de novo.
            self._signal(CLOSED_FLAG)
            env.stop()
        else:
            raise ValueError(f"item de menu desconhecido: {action}")

    # -- estado e balão
    # ------------------------------------------------------------------------------------

    def refresh(self, *, announce: bool = True) -> TrayView:
        """Lê o estado, decide o ícone e, numa falha de atualização nova, abre o balão (uma vez).

        `announce=False` é a primeira leitura, antes de o ícone existir: o balão fica para a
        próxima, senão a falha de uma atualização feita no logon (a mais comum) seria dada como
        avisada sem ninguém ter visto. Já uma visualização da tela em curso nessa hora não está
        começando: não ganha balão."""
        env = self._env
        now = env.now()
        inputs = env.read_inputs(now)
        view = view_of(inputs)
        self.inputs, self.view = inputs, view
        if announce:
            self._notify_viewing(inputs.screen_session, now)
            self._maybe_notify(inputs, now)
        elif inputs.screen_session:
            self._viewing_seen = now
            self._viewing_session = inputs.screen_session
        return view

    def _notify_viewing(self, session: str | None, now: datetime) -> None:
        """Balão só quando a visualização começa; sem entrega, a próxima leitura tenta de novo."""
        if session is None or session == self._stopped_screen:
            return
        seen = self._viewing_seen
        # A mesma sessão já avisada é a mesma visualização, mesmo após uma pausa longa do laço
        # (ex.: suspensão). Já outra sessão só emenda se a anterior foi vista há pouco (renovação).
        same_session = seen is not None and session == self._viewing_session
        renewed = seen is not None and now - seen <= VIEWING_RESUMES_WITHIN
        if same_session or renewed or self._env.notify(VIEWING_MESSAGE, VIEWING_TITLE):
            self._viewing_seen = now
            self._viewing_session = session

    def _maybe_notify(self, inputs: TrayInputs, now: datetime) -> None:
        checked = inputs.update_checked_at
        if not should_notify_update_failure(
            inputs.update_outcome, checked, self._last_notified(), now
        ):
            return
        assert checked is not None  # noqa: S101 - `should_notify...` já exigiu
        delivered = self._env.notify(
            "A atualização do UniOver falhou. Veja o registro.", "Falha na Atualização"
        )
        if delivered:
            self._remember(checked.isoformat())

    def _last_notified(self) -> str | None:
        if self._announced is not None:
            return self._announced
        try:
            data = json.loads(
                (self._env.base / "runtime" / NOTIFIED_FILE).read_text(encoding="utf-8")
            )
        except OSError, ValueError:
            return None
        value = data.get("checkedAt") if isinstance(data, dict) else None
        return value if isinstance(value, str) else None

    def _remember(self, checked_at: str) -> None:
        self._announced = checked_at
        try:
            path = self._env.base / "runtime" / NOTIFIED_FILE
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"checkedAt": checked_at}), encoding="utf-8")
        except OSError:
            _log.warning("não consegui lembrar do aviso de atualização")


def promote_in_background(  # noqa: PLR0913 - cada peça é injetada para o teste
    settings: NotifyIconSettings,
    marker: PromotionMarker,
    own_executable: str,
    record: Record,
    *,
    sleep: Callable[[float], None] = time.sleep,
    every: float = PROMOTE_EVERY_SECONDS,
    window: float = PROMOTE_FOR_SECONDS,
) -> PromotionResult:
    """Espera o Windows criar a linha do ícone e o promove uma vez. Devolve o resultado final."""
    waited = 0.0
    result = promote_once(settings, marker, own_executable)
    while result == "not_found" and waited < window:
        sleep(every)
        waited += every
        result = promote_once(settings, marker, own_executable)
    if result == "failed":
        record("tray.promote_failed", "error", "não consegui deixar o ícone visível na barra")
    return result
