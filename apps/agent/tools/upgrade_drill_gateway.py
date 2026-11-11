r"""API falsa do ensaio de atualização: o bastante para o agente conectar e a passagem sem queda.

O ensaio aponta o `api_url` do agente para este servidor (e não para o servidor que faz as vezes do
GitHub). Ele faz o que a API de verdade faz no que importa para a passagem de uma versão para outra:

- `GET /api/v1/devices/info` lista as `features` (com `agent.handover.v1` quando a passagem está
  ligada: o agente só a tenta com a API dizendo que a sabe);
- o WebSocket do agente tem um dono só. A conexão comum (rota `.../ws`) assume na hora e a
  antiga sai com `4409 replaced`. A CANDIDATA da passagem (rota própria `.../ws/handover`, que uma
  API sem a passagem não tem: responde 404) fica fora do roteamento até um `hello` com
  `handover: true` e `instanceId`: então é promovida (troca atômica), recebe
  `agent.handover.accepted.v1` (com o `instanceId` e o id do hello) e a antiga sai com
  `4410 handover` se declarou `agent.handover.v1` no `hello` (senão, com `4409 replaced`, que
  qualquer versão entende). Qualquer outro primeiro quadro, o silêncio ou a queda a descartam sem
  tocar na antiga;
- guarda, com horário, cada conexão, `hello` e fechamento, e os `kind` dos diagnósticos que o agente
  envia, para o ensaio medir: houve algum instante sem agente conectado (a janela da atualização)?

Nunca fala com a rede de fora: escuta só em 127.0.0.1. Só o ensaio e o teste dele o usam.
"""

import asyncio
import contextlib
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

AGENT_SLUG = "drill-agent"
WS_PATH = f"/api/v1/devices/agents/{AGENT_SLUG}/ws"
HANDOVER_WS_PATH = f"{WS_PATH}/handover"
INFO_PATH = "/api/v1/devices/info"
HANDOVER_FEATURE = "agent.handover.v1"
ACCEPTED_TYPE = "agent.handover.accepted.v1"
# Sempre listadas: o agente declara a capacidade do diagnóstico só se a API a aceita.
BASE_FEATURES = ("agent.diagnostics.v1",)
# A API de verdade espera até isto o primeiro quadro da conexão nova antes de fechar a antiga.
FIRST_FRAME_WAIT_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class Event:
    at: float
    kind: str
    session: int
    detail: str = ""


@dataclass(slots=True)
class Session:
    number: int
    socket: ServerConnection
    hello: dict[str, Any] = field(default_factory=dict)


class Gateway:
    def __init__(self, *, handover: bool = True) -> None:
        # Mudar em pleno ensaio vale para a próxima conexão: é assim que ele alterna os cenários.
        self.handover_supported = handover
        self.events: list[Event] = []
        self.diagnostics: list[str] = []
        self.port = 0
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._server: Server | None = None
        self._ready = threading.Event()
        self._current: Session | None = None
        self._count = 0

    # ---- ciclo de vida

    def start(self) -> int:
        self._thread = threading.Thread(target=self._run, name="drill-gateway", daemon=True)
        self._thread.start()
        if not self._ready.wait(15):
            raise RuntimeError("a API falsa do ensaio nao subiu")
        return self.port

    def stop(self) -> None:
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=10)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._serve())
        loop.run_forever()
        with contextlib.suppress(Exception):
            loop.run_until_complete(self._shutdown())
        loop.close()

    async def _serve(self) -> None:
        self._server = await serve(
            self._handle,
            "127.0.0.1",
            0,
            process_request=self._process,
            max_size=2**20,
            ping_interval=None,
        )
        self.port = next(iter(self._server.sockets)).getsockname()[1]
        self._ready.set()

    async def _shutdown(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # ---- HTTP

    def features(self) -> list[str]:
        listed = list(BASE_FEATURES)
        if self.handover_supported:
            listed.append(HANDOVER_FEATURE)
        return listed

    async def _process(self, connection: ServerConnection, request: Request) -> Response | None:
        if request.path == INFO_PATH:
            body = json.dumps(
                {"module": "devices", "version": "drill", "features": self.features()}
            )
            headers = Headers([("Content-Type", "application/json")])
            return Response(HTTPStatus.OK.value, HTTPStatus.OK.phrase, headers, body.encode())
        if request.path == WS_PATH or (
            request.path == HANDOVER_WS_PATH and self.handover_supported
        ):
            return None
        # Inclusive a rota da candidata quando a API não sabe a passagem: ela não existe.
        return Response(HTTPStatus.NOT_FOUND.value, HTTPStatus.NOT_FOUND.phrase, Headers(), b"")

    # ---- WebSocket: um dono por agente

    def _note(self, kind: str, session: int, detail: str = "") -> None:
        with self._lock:
            self.events.append(Event(time.time(), kind, session, detail))

    async def _handle(self, connection: ServerConnection) -> None:
        candidate = connection.request is not None and connection.request.path == HANDOVER_WS_PATH
        with self._lock:
            self._count += 1
            session = Session(self._count, connection)
        connected = False
        try:
            if candidate:
                connected = await self._admit(session)
                if not connected:
                    return
            else:
                previous = self._attach(session)
                connected = True
                if previous is not None:
                    self._note("close-previous", previous.number, "4409 replaced")
                    with contextlib.suppress(Exception):
                        await previous.socket.close(4409, "replaced")
            async for raw in connection:
                self._see(session, self._parse(raw))
        except Exception as exc:
            self._note("error", session.number, type(exc).__name__)
        finally:
            if connected:
                with self._lock:
                    if self._current is session:
                        self._current = None
                self._note("disconnect", session.number)

    def _attach(self, session: Session) -> Session | None:
        """A troca atômica: a sessão vira a dona, e a anterior (se havia) é devolvida."""
        with self._lock:
            previous = self._current
            self._current = session
        self._note("connect", session.number)
        return previous

    async def _admit(self, session: Session) -> bool:
        """A candidata só entra com um hello de passagem válido; senão é descartada."""
        self._note("candidate", session.number)
        try:
            first = await asyncio.wait_for(session.socket.recv(), FIRST_FRAME_WAIT_SECONDS)
        except TimeoutError, Exception:
            self._note("candidate-dropped", session.number, "sem quadro")
            return False
        message = self._parse(first)
        body = message.get("body") if message.get("type") == "agent.hello.v1" else None
        instance = body.get("instanceId") if isinstance(body, dict) else None
        if not (
            isinstance(body, dict)
            and body.get("handover") is True
            and isinstance(instance, str)
            and instance
            and self.handover_supported
        ):
            self._note("candidate-dropped", session.number, "hello sem passagem valida")
            with contextlib.suppress(Exception):
                await session.socket.close(1008, "policy_violation")
            return False
        previous = self._attach(session)
        self._see(session, message)
        # A confirmação é a primeira coisa que a nova recebe, antes de a antiga ser fechada.
        ack = {
            "v": 1,
            "id": str(uuid.uuid4()),
            "type": ACCEPTED_TYPE,
            "source": "api",
            "target": f"agent:{AGENT_SLUG}",
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z",
            "correlationId": message.get("id"),
            "body": {"instanceId": instance},
        }
        await session.socket.send(json.dumps(ack))
        self._note("ack", session.number, str(instance))
        if previous is not None:
            # O 4410 só vai a quem declarou entendê-lo; a que não declarou sai como substituída.
            capabilities = previous.hello.get("capabilities")
            if isinstance(capabilities, list) and HANDOVER_FEATURE in capabilities:
                self._note("close-previous", previous.number, "4410 handover")
                with contextlib.suppress(Exception):
                    await previous.socket.close(4410, "handover")
            else:
                self._note("close-previous", previous.number, "4409 replaced (sem a capacidade)")
                with contextlib.suppress(Exception):
                    await previous.socket.close(4409, "replaced")
        return True

    def _see(self, session: Session, message: dict[str, Any]) -> None:
        if message.get("type") == "agent.hello.v1":
            session.hello = message.get("body", {})
            self._note(
                "hello",
                session.number,
                f"handover={session.hello.get('handover') is True} "
                f"version={session.hello.get('agentVersion', '?')}",
            )
        self._observe(message)

    @staticmethod
    def _parse(raw: str | bytes | None) -> dict[str, Any]:
        if raw is None:
            return {}
        try:
            loaded = json.loads(raw)
        except ValueError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def _observe(self, message: dict[str, Any]) -> None:
        if message.get("type") != "agent.diagnostics.v1":
            return
        body = message.get("body")
        events = body.get("events") if isinstance(body, dict) else None
        if not isinstance(events, list):
            return
        with self._lock:
            self.diagnostics.extend(
                str(item.get("kind")) for item in events if isinstance(item, dict)
            )

    # ---- o que o ensaio mede

    def snapshot(self) -> list[Event]:
        with self._lock:
            return list(self.events)

    def connected(self) -> bool:
        with self._lock:
            return self._current is not None

    def disconnections_since(self, since: float) -> list[Event]:
        """Os instantes, depois de `since`, em que a API ficou sem nenhum agente conectado."""
        found: list[Event] = []
        live: set[int] = set()
        for event in self.snapshot():
            if event.kind == "connect":
                live.add(event.session)
            elif event.kind == "disconnect":
                live.discard(event.session)
                if not live and event.at >= since:
                    found.append(event)
        return found

    def longest_gap_since(self, since: float) -> float:
        """O maior intervalo, depois de `since`, sem nenhuma conexão de agente (0 se não houve)."""
        longest = 0.0
        down_at: float | None = None
        live: set[int] = set()
        for event in self.snapshot():
            if event.kind == "connect":
                if down_at is not None and event.at >= since:
                    longest = max(longest, event.at - max(down_at, since))
                down_at = None
                live.add(event.session)
            elif event.kind == "disconnect":
                live.discard(event.session)
                if not live:
                    down_at = event.at
        if down_at is not None and not live:
            longest = max(longest, time.time() - max(down_at, since))
        return longest

    def current_declares_handover(self) -> bool:
        """A conexão atual já declarou `agent.handover.v1` no `hello` (soube que a API a aceita)."""
        with self._lock:
            current = self._current
        capabilities = current.hello.get("capabilities") if current is not None else None
        return isinstance(capabilities, list) and HANDOVER_FEATURE in capabilities

    def handover_closes(self, since: float) -> list[Event]:
        return [
            event
            for event in self.snapshot()
            if event.at >= since and event.kind == "close-previous" and "4410" in event.detail
        ]

    def acks(self, since: float) -> list[Event]:
        """As confirmações `agent.handover.accepted.v1` que a API falsa enviou depois de `since`."""
        return [e for e in self.snapshot() if e.at >= since and e.kind == "ack"]

    def dropped_candidates(self, since: float) -> list[Event]:
        return [e for e in self.snapshot() if e.at >= since and e.kind == "candidate-dropped"]

    def hello_handovers(self, since: float) -> list[Event]:
        return [
            event
            for event in self.snapshot()
            if event.at >= since and event.kind == "hello" and "handover=True" in event.detail
        ]
