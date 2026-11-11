"""Aprovação de aparelho novo no PC: o dono confirma, na tela do próprio PC, a primeira vez.

Quem controla o PC pelo app já passou pelo login e pela permissão do módulo na API; isto é uma
camada a mais, que só o dono sentado no PC concede: na primeira vez que um aparelho (a sessão do
app, identificada pela API em `deviceId`) pede controle, o agente pergunta no PC "Permitir que
<nome> controle este PC?". Permitiu: o aparelho fica aprovado e não é perguntado de novo. Recusou: o
app recebe um 403 claro; a recusa vale por uma hora (para não incomodar a cada toque) e depois o
aparelho pode pedir de novo. Enquanto a pergunta está aberta, o comando volta como pendente.

O que o agente guarda é só um resumo do identificador (nunca o identificador em si) e o nome para
mostrar, que a API tirou do navegador e que aqui é limpo de qualquer texto de controle.
"""

import asyncio
import hashlib
import logging
import re
import time
import unicodedata
from collections.abc import Callable
from enum import StrEnum
from typing import Final

from uniover_agent.ports.pc_devices import ApprovalPrompt, DeviceRecord, DeviceStore

_log = logging.getLogger(__name__)

# Códigos estáveis (`command.result.v1`) que o app traduz em "aguardando no PC" e "recusado".
DEVICE_PENDING: Final = "device_pending"
DEVICE_DENIED: Final = "device_denied"
# Comando sem aparelho identificado enquanto não se sabe se a API faz a aprovação: falha fechado.
DEVICE_UNKNOWN: Final = "device_unknown"
APPROVED: Final = "approved"
DENIED: Final = "denied"

# A recusa vale por isto; depois o aparelho pode pedir de novo.
DENIED_TTL_SECONDS: Final = 3600.0
# Depois de uma pergunta que não deu para fazer, espera isto antes de tentar de novo.
RETRY_AFTER_SECONDS: Final = 30.0
# Com a API já vista oferecendo a aprovação mas sem listá-la agora (instância antiga no rollout), no
# máximo uma nova consulta de features por este tempo: o `hello` volta a declarar a capacidade logo.
REFRESH_EVERY_SECONDS: Final = 15.0
# Quanto tempo a API vale o aviso de pendente ou recusado, e de quanto em quanto tempo o agente o
# renova enquanto o aparelho insiste (sem uma mensagem por movimento).
ANNOUNCE_EVERY_SECONDS: Final = 10.0
# Decisões guardadas no máximo (as mais antigas saem primeiro).
MAX_RECORDS: Final = 200
MAX_NAME: Final = 60
_SPACES = re.compile(r"\s+")


class DeviceDecision(StrEnum):
    APPROVED = "approved"
    PENDING = "pending"
    DENIED = "denied"
    # O comando não traz aparelho e o agente ainda não sabe se a API o identifica.
    UNKNOWN = "unknown"


# Avisa a API do estado de um aparelho (`pending`, `denied`, `approved`); não bloqueia.
Announcer = Callable[[str, str], None]


def device_key(device_id: str) -> str:
    """O identificador resumido (SHA-256 truncado): é o que fica no arquivo e no registro."""
    return hashlib.sha256(device_id.encode("utf-8")).hexdigest()[:32]


def clean_name(name: str | None) -> str:
    """O nome do aparelho como o dono o vê: sem controle, sem formatação invisível, sem excesso."""
    text = "".join(ch for ch in (name or "") if unicodedata.category(ch)[0] != "C" or ch in " \t")
    text = _SPACES.sub(" ", text).strip()[:MAX_NAME].strip()
    return text or "um aparelho"


class DeviceApprovals:
    """As decisões e a pergunta ao dono. Só roda no laço da faixa do PC (um laço, sem trava)."""

    def __init__(  # noqa: PLR0913 - prazos trocáveis para os testes
        self,
        store: DeviceStore,
        prompt: ApprovalPrompt,
        *,
        now: Callable[[], float] = time.time,
        denied_ttl_seconds: float = DENIED_TTL_SECONDS,
        retry_after_seconds: float = RETRY_AFTER_SECONDS,
        announce_every_seconds: float = ANNOUNCE_EVERY_SECONDS,
    ) -> None:
        self._store = store
        self._prompt = prompt
        self._now = now
        self._denied_ttl = denied_ttl_seconds
        self._retry_after = retry_after_seconds
        self._announce_every = announce_every_seconds
        self._announcer: Announcer | None = None
        self._announced_at: dict[str, float] = {}
        # A API só conta como "sem aprovação" quando respondeu e não a listou (decisão explícita);
        # sem ligação (testes, partida) vale o contrário: falha fechado.
        self._api_answered: Callable[[], bool] = lambda: False
        self._api_supports: Callable[[], bool] = lambda: False
        self._request_refresh: Callable[[], None] | None = None
        self._refreshed_at = -1e9
        self._seen_saved = False
        self._legacy_logged = False
        # A API já listou a aprovação alguma vez (gravado): daí em diante "não lista" é uma resposta
        # suspeita (instância antiga no deploy, página torta), nunca o modo sem aprovação.
        try:
            self._api_seen = store.api_seen()
        except Exception:
            self._api_seen = False
        self._seen_saved = self._api_seen
        self._records: dict[str, DeviceRecord] = {}
        try:
            self._records = dict(store.load())
        except Exception:
            _log.warning("não consegui ler os aparelhos aprovados; recomeçando sem eles")
        # Perguntas em andamento (chave -> tarefa) e quando cada uma pode ser tentada de novo.
        self._asking: dict[str, asyncio.Task[None]] = {}
        self._retry_at: dict[str, float] = {}
        # Uma janela de cada vez: os outros aparelhos esperam a vez como pendentes.
        self._one_at_a_time = asyncio.Lock()

    def bind_api(
        self,
        *,
        answered: Callable[[], bool],
        supports: Callable[[], bool],
        announce: Announcer,
        refresh: Callable[[], None] | None = None,
    ) -> None:
        """Liga ao que se sabe da API: `answered` (ela já disse o que aceita), `supports` (ela
        identifica o aparelho e entende `pc.device.state.v1`) e `announce` (o aviso de estado)."""
        self._api_answered = answered
        self._api_supports = supports
        self._announcer = announce
        self._request_refresh = refresh

    def note_api(self) -> None:
        """A API listou a aprovação: grava, e o modo sem aprovação nunca mais volta."""
        if not self._api_supports():
            return
        # Em memória na hora (a segurança não espera o disco); o arquivo é tentado de novo a cada
        # nota enquanto a gravação não der certo.
        self._api_seen = True
        if self._seen_saved:
            return
        try:
            self._store.mark_api_seen()
        except Exception:
            _log.warning("não consegui gravar que a API oferece a aprovação", exc_info=True)
        else:
            self._seen_saved = True

    def api_without_approval(self) -> bool:
        """A API respondeu e NÃO oferece a aprovação, e nunca a ofereceu (uma API anterior):
        decisão explícita. Quem já a viu listada uma vez não volta a este modo."""
        self.note_api()
        return not self._api_seen and self._api_answered() and not self._api_supports()

    def _ask_for_features(self) -> None:
        """A API já ofereceu a aprovação mas não a lista agora: pede nova consulta de features (no
        máximo uma a cada `REFRESH_EVERY_SECONDS`), para o `hello` voltar a declarar a capacidade
        logo e o aparelho aprovado não ficar até o próximo ciclo (5 min) em `device_unknown`."""
        if self._request_refresh is None or not self._api_seen or self._api_supports():
            return
        now = self._now()
        if now - self._refreshed_at < REFRESH_EVERY_SECONDS:
            return
        self._refreshed_at = now
        try:
            self._request_refresh()
        except Exception:
            _log.debug("pedido de nova consulta de features não enviado", exc_info=True)

    def check(self, device_id: str | None, device_name: str | None) -> DeviceDecision:
        self.note_api()
        return self._check(device_id, device_name)

    def _check(self, device_id: str | None, device_name: str | None) -> DeviceDecision:
        """A decisão sobre o aparelho; a primeira vez (ou após a recusa vencida) abre a pergunta.

        Sem `device_id` (o comando não traz aparelho): passa só se a API confirmou que não faz a
        aprovação; com isso desconhecido (partida, consulta que falhou) falha fechado, e o app
        tenta de novo quando as duas pontas tiverem negociado.
        """
        if device_id is None:
            if self.api_without_approval():
                if not self._legacy_logged:
                    self._legacy_logged = True
                    _log.info("a API não oferece a aprovação de aparelho; comandos passam sem ela")
                return DeviceDecision.APPROVED
            self._ask_for_features()
            return DeviceDecision.UNKNOWN
        key = device_key(device_id)
        record = self._records.get(key)
        if record is not None:
            if record.state == APPROVED:
                return DeviceDecision.APPROVED
            if self._now() - record.at < self._denied_ttl:
                self._announce(device_id, key, DENIED, force=False)
                return DeviceDecision.DENIED
        if key in self._asking or self._now() < self._retry_at.get(key, 0.0):
            self._announce(device_id, key, "pending", force=False)
            return DeviceDecision.PENDING
        name = clean_name(device_name)
        _log.info("aparelho novo pede controle do PC; perguntando ao dono (%s)", key[:8])
        task = asyncio.ensure_future(self._ask(key, name, device_id))
        self._asking[key] = task
        self._announce(device_id, key, "pending", force=True)
        task.add_done_callback(lambda _: self._asking.pop(key, None))
        return DeviceDecision.PENDING

    def _announce(self, device_id: str, key: str, state: str, *, force: bool) -> None:
        """Conta à API o estado do aparelho, no máximo a cada `announce_every_seconds` por aparelho
        (a mudança de decisão sempre vai): é o que deixa a API responder ao movimento do mouse, que
        aqui é descartado sem resposta, sem uma mensagem por movimento."""
        if self._announcer is None or not self._api_supports():
            return
        now = self._now()
        if not force and now - self._announced_at.get(key, -1e9) < self._announce_every:
            return
        self._announced_at[key] = now
        try:
            self._announcer(device_id, state)
        except Exception:
            _log.debug("aviso do estado do aparelho não enviado", exc_info=True)

    async def _ask(self, key: str, name: str, device_id: str) -> None:
        async with self._one_at_a_time:
            try:
                answer = await self._prompt.ask(name)
            except Exception:
                _log.warning("a pergunta ao dono falhou", exc_info=True)
                answer = None
        if answer is None:
            self._retry_at[key] = self._now() + self._retry_after
            _log.warning("não deu para perguntar ao dono no PC; o aparelho segue pendente")
            return
        self._records[key] = DeviceRecord(APPROVED if answer else DENIED, name, self._now())
        self._retry_at.pop(key, None)
        self._trim()
        try:
            self._store.save(dict(self._records))
        except Exception:
            _log.warning("não consegui gravar a decisão sobre o aparelho", exc_info=True)
        _log.info("aparelho %s pelo dono (%s)", "aprovado" if answer else "recusado", key[:8])
        self._announce(device_id, key, APPROVED if answer else DENIED, force=True)

    def _trim(self) -> None:
        extra = len(self._records) - MAX_RECORDS
        if extra > 0:
            for key in sorted(self._records, key=lambda k: self._records[k].at)[:extra]:
                del self._records[key]

    async def aclose(self) -> None:
        """Encerra: a janela aberta é fechada (sem decisão) e as perguntas terminam."""
        tasks = list(self._asking.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._prompt.aclose()
