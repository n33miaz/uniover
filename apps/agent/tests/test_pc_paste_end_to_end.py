"""Colar um texto longo, com muitas linhas, de ponta a ponta pelo agente.

O caminho é o de verdade (conexão, validação do contrato, idade do comando, repetição pelo `id`,
fila do PC, adaptador do Windows); só o `SendInput` é trocado por um dublê que registra o que o
Windows teria aceitado. Nada toca no teclado deste PC.
"""

import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from functools import partial
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters.fakes import FakeSecretStore
from uniover_agent.adapters.pc_inputs import KEY_UNICODE, KEY_UP, RawInput
from uniover_agent.adapters.pc_windows import PartialSendError, WindowsPcInput
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition.pc import build_pc
from uniover_agent.composition.system import EXIT_CREDENTIAL_REJECTED, silence_noisy_loggers
from uniover_agent.config import Settings

from .support import AGENT_ID, TOKEN, FakeApi, FakeAudio, dump, envelope
from .test_pc_composition import FakeLauncher, FakePower

# Uma lista de pedidos colada do chat: linhas, marcadores, tabulação, acentos e emoji.
LINE = '- pedido número {n}: conferir (o) "campo"; ação — ok 😀\n\tdetalhe {n}\n'
PASTED = "".join(LINE.format(n=n) for n in range(60))
# O app manda o texto colado em pedidos de até 200 caracteres (pontos de código), em ordem.
MAX_TEXT = 200
_KEY_CHARS = {0x0D: "\n", 0x09: "\t"}


def chunks(text: str, size: int = MAX_TEXT) -> list[str]:
    points = list(text)
    return ["".join(points[i : i + size]) for i in range(0, len(points), size)]


def now_ts() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SendInput:
    """`SendInput` falso: registra só o que o Windows teria aceitado. `plan` diz, por chamada (a
    contar de 0), quantos eventos aceitar (`0` recusa o lote todo)."""

    def __init__(self, plan: dict[int, int] | None = None) -> None:
        self.plan = dict(plan or {})
        self.calls = 0
        self.accepted: list[RawInput] = []

    def __call__(self, inputs: Sequence[RawInput]) -> None:
        batch = list(inputs)
        limit = self.plan.pop(self.calls, None)
        self.calls += 1
        if limit is not None and limit < len(batch):
            self.accepted += batch[:limit]
            raise PartialSendError(limit, len(batch))
        self.accepted += batch


def typed_units(events: Sequence[RawInput]) -> bytes:
    """As unidades UTF-16 que os apertos formam, na ordem (Enter vira quebra de linha, Tab vira
    tabulação)."""
    units = bytearray()
    for event in events:
        if event.kind != "keyboard" or event.flags & KEY_UP:
            continue
        if event.flags & KEY_UNICODE:
            units += event.scan.to_bytes(2, "little")
        else:
            units += _KEY_CHARS[event.vk].encode("utf-16-le")
    return bytes(units)


def typed(events: Sequence[RawInput]) -> str:
    return typed_units(events).decode("utf-16-le")


def assert_never_held(events: Sequence[RawInput]) -> None:
    """Cada tecla apertada é solta antes de qualquer outra ser apertada, e nada sobra apertado: é o
    que impede a repetição automática de um caractere."""
    held: set[tuple[int, int, int]] = set()
    for index, event in enumerate(events):
        identity = (event.vk, event.scan, event.flags & ~KEY_UP)
        if event.flags & KEY_UP:
            assert identity in held, f"soltura sem aperto no evento {index}"
            held.discard(identity)
        else:
            assert not held, f"evento {index} apertado com outra tecla ainda apertada"
            held.add(identity)
    assert not held, "sobrou tecla apertada"


async def paste(
    monkeypatch: pytest.MonkeyPatch,
    send: SendInput,
    messages: list[dict[str, Any]],
    *,
    answers: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Manda `messages` pela conexão, uma depois da outra, espera `answers` respostas (todas, sem
    o número) e derruba a conexão. Devolve o resultado de cada comando pelo `id`."""
    monkeypatch.setattr(
        connection_module,
        "build_pc",
        partial(
            build_pc,
            platform="win32",
            pc_input=WindowsPcInput(send),
            power=FakePower(),
            launcher=FakeLauncher(),
            audio=FakeAudio(),
        ),
    )
    results: dict[str, dict[str, Any]] = {}
    expected = len({m["id"] for m in messages}) if answers is None else answers

    async def script(connection: ServerConnection) -> None:
        # Dois batimentos que concordam dão ao agente a referência de relógio da idade.
        for _ in range(2):
            await connection.send(dump(envelope("api.keepalive.v1", {}, ts=now_ts())))
        for message in messages:
            await connection.send(dump(message))
        async with asyncio.timeout(10):
            while len(results) < expected:
                received = json.loads(await connection.recv())
                if received["type"] == "command.result.v1":
                    results[received["correlationId"]] = received["body"]
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    silence_noisy_loggers()
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, pc_control=True
        )
        assert await run_agent(settings, store) == EXIT_CREDENTIAL_REJECTED
    return results


async def run_agent(settings: Settings, store: FakeSecretStore) -> int:
    return await connection_module.run(settings, lambda: store)


def text_v3(text: str, **overrides: Any) -> dict[str, Any]:
    return envelope("pc.text.v3", {"text": text}, ts=now_ts(), **overrides)


def test_the_pasted_text_is_long_and_has_many_lines() -> None:
    assert len(PASTED) > 3000
    assert PASTED.count("\n") >= 100 and PASTED.count("\t") >= 50
    assert len(chunks(PASTED)) > 10


async def test_a_long_multiline_paste_arrives_once_in_order_with_nothing_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parts = chunks(PASTED)
    messages = [text_v3(part) for part in parts]
    # A API manda de novo o terceiro pedido (mesmo `id`): ele não é digitado outra vez.
    resent = dict(messages[2])
    # Um pedido que chegou velho demais (mais de 5 s) é recusado inteiro, sem apertar nada.
    expired = envelope("pc.text.v3", {"text": "nunca\ndigitado"}, ts="2026-10-19T12:00:00.000Z")
    send = SendInput()
    results = await paste(monkeypatch, send, [*messages[:3], resent, expired, *messages[3:]])
    assert all(results[m["id"]] == {"ok": True} for m in messages)
    assert results[expired["id"]]["ok"] is False
    assert typed(send.accepted) == PASTED
    assert_never_held(send.accepted)
    # Quebra de linha e tabulação viram as teclas Enter e Tab, apertadas e soltas lado a lado.
    enters = [e for e in send.accepted if e.vk == 0x0D and not e.flags & KEY_UP]
    assert len(enters) == PASTED.count("\n")


async def test_a_cut_batch_with_a_refused_release_never_leaves_a_key_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parts = chunks(PASTED)[:4]
    messages = [text_v3(part) for part in parts]
    # O segundo envio ao Windows (o segundo lote do primeiro pedido) entra só até um aperto, sem a
    # soltura; a soltura em seguida é recusada uma vez (janela que não aceita entrada) e depois
    # aceita. O que entrou nunca se repete e a tecla não fica apertada.
    send = SendInput({1: 9, 2: 0})
    results = await paste(monkeypatch, send, messages)

    assert results[messages[0]["id"]]["ok"] is False
    assert all(results[m["id"]] == {"ok": True} for m in messages[1:])
    assert_never_held(send.accepted)
    # O que entrou é um começo do primeiro pedido (nada repetido) e depois os outros inteiros.
    units = typed_units(send.accepted)
    tail = "".join(parts[1:]).encode("utf-16-le")
    assert units.endswith(tail)
    head = units[: len(units) - len(tail)]
    assert parts[0].encode("utf-16-le").startswith(head)
    assert 0 < len(head) < len(parts[0].encode("utf-16-le"))


async def test_a_disconnect_right_after_a_cut_batch_still_lets_the_key_go(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    message = text_v3(chunks(PASTED)[0])
    # O primeiro lote entra só até um aperto (3 eventos: aperta, solta, aperta) e a soltura em
    # seguida é recusada; a conexão cai logo depois da resposta de erro, antes da nova tentativa.
    send = SendInput({0: 3, 1: 0})
    results = await paste(monkeypatch, send, [message])

    assert results[message["id"]]["ok"] is False
    assert send.calls >= 3, "lote cortado, soltura recusada e soltura aceita"
    stuck = send.accepted[2]
    assert not stuck.flags & KEY_UP
    keyboard = [event for event in send.accepted if event.kind == "keyboard"]
    assert keyboard[-1] == RawInput("keyboard", flags=stuck.flags | KEY_UP, scan=stuck.scan)
    assert_never_held(send.accepted)
