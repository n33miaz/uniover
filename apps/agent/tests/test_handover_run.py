"""Passagem sem queda de ponta a ponta: `run --handover` e a execução antiga que é substituída.

O servidor falso faz o papel da API: lê o `hello`, fecha com o código que a API usaria e confere o
que o agente disse. Nada aqui toca na instalação real (a pasta é a do teste).
"""

import asyncio
import json
import os
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTvRemote
from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.single_instance import EXIT_ALREADY_RUNNING
from uniover_agent.care_setup import announce_start
from uniover_agent.composition import connection as connection_module
from uniover_agent.composition.connection import run
from uniover_agent.composition.pc import build_pc
from uniover_agent.composition.system import (
    EXIT_CREDENTIAL_REJECTED,
    EXIT_HANDOVER_UNSUPPORTED,
    EXIT_OK,
    silence_noisy_loggers,
)
from uniover_agent.composition.tv import build_tv
from uniover_agent.config import Settings
from uniover_agent.core.api_features import HANDOVER_FEATURE

from .support import AGENT_ID, TOKEN, FakeApi, dump, envelope
from .test_pc_composition import FakeInput, FakeLauncher, FakePower
from .test_tv_composition import TV_HOST, pair_fake_tv

CANDIDATE_PATH = f"/api/v1/devices/agents/{AGENT_ID}/ws/handover"

# Resposta da rota pública `devices/info` de uma API que sabe passar a conexão.
LISTED = frozenset({"agent.diagnostics.v1", "pc.key.v2", "pc.text.v2", HANDOVER_FEATURE})


def features_of(found: frozenset[str] | None) -> Callable[..., Awaitable[frozenset[str] | None]]:
    async def fetch(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        return found

    return fetch


def settings_for(api: FakeApi) -> Settings:
    return Settings(
        api_url=api.http_url,
        agent_id=AGENT_ID,
        allow_insecure=True,
        pc_control=True,
        update_handover=True,
    )


def store() -> FakeSecretStore:
    secrets = FakeSecretStore()
    secrets.set(AGENT_ID, TOKEN)
    return secrets


def runtime() -> Path:
    return installation_base() / "runtime"


async def accept(connection: ServerConnection, hello: dict[str, Any]) -> None:
    """O que a API faz com a candidata promovida: confirma, citando o id do hello e o instanceId."""
    ack = envelope(
        "agent.handover.accepted.v1",
        {"instanceId": hello["body"]["instanceId"]},
        correlation_id=hello["id"],
    )
    await connection.send(dump(ack))


def now_stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def test_a_handover_start_falls_back_when_the_handover_is_off_in_the_config() -> None:
    # `update_handover` desligada (o padrão): nada é aberto, nem a API é consultada.
    async with FakeApi() as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, pc_control=True
        )
        assert settings.update_handover is False
        code = await run(settings, store, handover=True)
    assert code == EXIT_HANDOVER_UNSUPPORTED
    assert api.connections == 0
    assert not (runtime() / "run-state.json").exists()


async def test_the_confirmation_deadline_counts_from_the_start_and_never_passes_the_supervisors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "HANDOVER_CONFIRM_SECONDS", 40.0)
    monkeypatch.delenv(connection_module.HANDOVER_DEADLINE_ENV, raising=False)
    assert connection_module._handover_budget() == 40.0
    monkeypatch.setenv(connection_module.HANDOVER_DEADLINE_ENV, str(time.time() + 12))
    assert 10.0 < connection_module._handover_budget() <= 12.0
    # Um prazo absoluto que já passou deixa só o mínimo (a execução desiste logo, sem bloquear).
    monkeypatch.setenv(connection_module.HANDOVER_DEADLINE_ENV, str(time.time() - 30))
    assert connection_module._handover_budget() == 1.0
    monkeypatch.setenv(connection_module.HANDOVER_DEADLINE_ENV, "lixo")
    assert connection_module._handover_budget() == 40.0
    monkeypatch.delenv(connection_module.HANDOVER_TAKEOVER_SECONDS_ENV, raising=False)
    assert connection_module._handover_takeover_budget() == 30.0
    monkeypatch.setenv(connection_module.HANDOVER_TAKEOVER_SECONDS_ENV, "12")
    assert connection_module._handover_takeover_budget() == 12.0
    monkeypatch.setenv(connection_module.HANDOVER_TAKEOVER_SECONDS_ENV, "0")
    assert connection_module._handover_takeover_budget() == 30.0


async def test_a_handover_start_falls_back_when_the_api_does_not_list_the_feature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(frozenset({"x"})))
    async with FakeApi() as api:
        code = await run(settings_for(api), store, handover=True)
    assert code == EXIT_HANDOVER_UNSUPPORTED
    # Nada foi aberto nem gravado: o supervisor só troca de caminho.
    assert api.connections == 0
    assert not (runtime() / "run-state.json").exists()
    assert not (runtime() / "connected.json").exists()


async def test_a_handover_start_falls_back_when_the_api_cannot_be_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(None))
    monkeypatch.setattr(connection_module, "HANDOVER_PROBE_SECONDS", 0.0)
    async with FakeApi() as api:
        code = await run(settings_for(api), store, handover=True)
    assert code == EXIT_HANDOVER_UNSUPPORTED
    assert api.connections == 0


async def test_a_handover_start_falls_back_when_the_api_instance_has_no_candidate_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A consulta de partida disse que a API sabia, mas a instância que atende a conexão é uma
    # anterior (troca em andamento): a rota da candidata responde 404, ninguém é substituído e a
    # execução desiste sem abrir nada.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: False)  # a antiga serve
    async with FakeApi(reject_status=404) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 15)
    assert code == EXIT_HANDOVER_UNSUPPORTED
    assert api.paths == [CANDIDATE_PATH]
    assert not (runtime() / "run-state.json").exists()
    assert not (runtime() / "connected.json").exists()


async def test_the_new_run_connects_first_and_only_then_opens_what_belongs_to_the_old_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.1)
    events: list[str] = []
    attempts = {"n": 0}

    def acquire(base: Path | None = None) -> bool:
        # A execução antiga ainda segura a trava nas duas primeiras tentativas.
        attempts["n"] += 1
        events.append(f"acquire:{attempts['n'] >= 3}")
        return attempts["n"] >= 3

    monkeypatch.setattr(connection_module, "acquire", acquire)

    def slug(agent_id: str) -> bool:
        events.append(f"slug:{agent_id}")
        return True

    monkeypatch.setattr(connection_module, "acquire_slug", slug)

    def announce(*args: Any, **kwargs: Any) -> Any:
        events.append("announce_start")
        return announce_start(*args, **kwargs)

    monkeypatch.setattr(connection_module, "announce_start", announce)

    class RecordingInput(FakeInput):
        def key(self, key: str, modifiers: Any, *, repeat: int = 1, action: str = "PRESS") -> None:
            events.append("key")
            super().key(key, modifiers, repeat=repeat, action=action)

    monkeypatch.setattr(
        connection_module,
        "build_pc",
        partial(
            build_pc,
            platform="win32",
            pc_input=RecordingInput(),
            power=FakePower(),
            launcher=FakeLauncher(),
        ),
    )
    hello: dict[str, Any] = {}

    async def script(connection: ServerConnection) -> None:
        hello.update(json.loads(await connection.recv()))
        events.append("hello")
        await accept(connection, hello)
        # A API já fez desta a dona: um comando chega antes de a antiga largar a TV e o PC.
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "A"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000c1",
                )
            )
        )
        # Já como dona (a antiga largou a trava na 3a tentativa), o comando seguinte executa.
        await asyncio.sleep(1.0)
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "B"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000c2",
                )
            )
        )
        await asyncio.sleep(0.5)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await run(settings_for(api), store, handover=True)
    assert code == EXIT_CREDENTIAL_REJECTED
    body = hello["body"]
    # A conexão se apresenta como candidata, na rota própria dela: a API só a promove com o hello.
    assert api.paths == [CANDIDATE_PATH]
    assert body["handover"] is True
    # O primeiro `hello` sai com o que a API já disse aceitar (a consulta da partida), e não com a
    # lista vazia de quem ainda não perguntou: senão a API anunciaria um agente mais pobre.
    assert {"pc.key.v2", "pc.text.v2", "agent.diagnostics.v1"} <= set(body["capabilities"])
    assert str(uuid.UUID(body["instanceId"])) == body["instanceId"]
    # Primeiro conectou e disse o hello; só depois de a trava vir é que o rastro da execução, a
    # arrumação da pasta e o comando seguraram a instalação.
    assert events.index("hello") < events.index("acquire:True")
    assert events.index("acquire:True") < events.index("announce_start") < events.index("key")
    # O comando que chegou antes da posse foi recusado na hora (sem prender a leitura do canal),
    # e só o que veio depois dela executou.
    assert events.count("key") == 1
    refusals = [m for m in api.received if m["type"] == "command.result.v1"]
    assert [
        (m["correlationId"], m["body"]["ok"], m["body"].get("error", {}).get("code"))
        for m in refusals
    ] == [
        ("0192f1e4-0000-7000-8000-0000000000c1", False, "agent_starting"),
        ("0192f1e4-0000-7000-8000-0000000000c2", True, None),
    ]
    # As duas travas: a da instalação e a da identidade, as duas só quando a antiga larga.
    assert f"slug:{AGENT_ID}" in events
    assert events.index(f"slug:{AGENT_ID}") > events.index("acquire:False")
    assert "acquire:False" in events
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert marker["connectedAt"] <= marker["readyAt"]


async def test_the_new_run_gives_up_when_the_api_never_confirms_the_handover(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "HANDOVER_CONFIRM_SECONDS", 0.3)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: False)
    started: list[bool] = []

    def announce(*args: Any, **kwargs: Any) -> Any:
        started.append(True)
        return announce_start(*args, **kwargs)

    monkeypatch.setattr(connection_module, "announce_start", announce)

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(5.0)

    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 10)
    # Código 5 ("outra instância já roda"): o supervisor mantém a antiga e tenta de novo depois.
    assert code == 5
    # Nunca foi a dona: não escreveu rastro nenhum de execução.
    assert started == []
    assert not (runtime() / "run-state.json").exists()


async def test_after_the_confirmation_the_new_run_waits_for_the_lock_within_its_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A API já promoveu esta execução e mandou a antiga sair (que não reconecta): desistir agora
    # deixaria o PC sem agente. A trava demora bem mais que o prazo de confirmação e a nova ainda
    # assim vira a dona quando ela vem. O prazo de confirmação folga o bastante para a conexão (numa
    # máquina ocupada ela leva centenas de ms) e a trava só abre bem depois dele.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "HANDOVER_CONFIRM_SECONDS", 1.0)
    monkeypatch.setattr(connection_module, "HANDOVER_WAIT_LOG_SECONDS", 0.1)
    first_try: list[float] = []

    def acquire(base: Path | None = None) -> bool:
        if not first_try:
            first_try.append(time.monotonic())
        return time.monotonic() - first_try[0] >= 2.5

    monkeypatch.setattr(connection_module, "acquire", acquire)
    monkeypatch.setattr(connection_module, "acquire_slug", lambda agent_id: True)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await asyncio.sleep(4.0)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 15)
    assert code == EXIT_CREDENTIAL_REJECTED
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert {"connectedAt", "readyAt"} <= set(marker)
    state = json.loads((runtime() / "run-state.json").read_text(encoding="utf-8"))
    assert state["reason"] == "credencial_recusada"


async def test_after_the_confirmation_the_new_run_defers_when_the_lock_never_arrives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setenv(connection_module.HANDOVER_TAKEOVER_SECONDS_ENV, "0.25")
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: False)
    monkeypatch.setattr(connection_module, "acquire_slug", lambda agent_id: True)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await asyncio.sleep(2.0)

    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 10)
    assert code == EXIT_ALREADY_RUNNING
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert "connectedAt" in marker and "readyAt" not in marker
    assert not (runtime() / "run-state.json").exists()


async def test_the_feature_probe_is_bounded_by_the_clock_not_by_the_sleeps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Cada consulta gasta 3 s (o prazo dela): contar só as esperas deixaria passar do prazo.
    clock = FakeClock()
    calls: list[float] = []

    async def fetch(base_url: str, wait_seconds: float = 10.0) -> frozenset[str] | None:
        calls.append(clock.monotonic())
        clock.advance(3.0)
        return None

    monkeypatch.setattr(connection_module, "fetch_api_features", fetch)
    found = await connection_module._handover_features("http://x", clock)
    assert found is None
    assert clock.monotonic() <= connection_module.HANDOVER_PROBE_SECONDS + 3.0 + 2.0
    # Com 15 s de prazo, 3 s por consulta e 2 s de espera: no máximo 4 consultas (e não 8).
    assert len(calls) <= 4


@pytest.mark.parametrize("isolate_input", [False, True], ids=["same-loop", "input-thread"])
async def test_the_old_run_exits_cleanly_and_releases_what_it_held_when_the_api_hands_over(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], isolate_input: bool
) -> None:
    # Com a entrada do PC numa thread própria a faixa fecha no laço dela: as teclas são soltas lá,
    # e a thread para (com prazo) antes de a execução sair.
    pc_input = FakeInput()
    monkeypatch.setattr(
        connection_module,
        "build_pc",
        partial(
            build_pc,
            platform="win32",
            pc_input=pc_input,
            power=FakePower(),
            launcher=FakeLauncher(),
            isolate_input=isolate_input,
        ),
    )

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        # ALT apertado e seguro quando a versão nova assume.
        await connection.send(
            dump(
                envelope(
                    "pc.key.v2",
                    {"key": "ALT", "action": "DOWN"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000d1",
                )
            )
        )
        await asyncio.sleep(0.4)
        await connection.close(4410, "handover")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await run(settings_for(api), store)
    # Saída ordenada (0), sem o aviso de "token revogado" e sem reconectar.
    assert code == EXIT_OK
    assert api.connections == 1
    assert "Token revogado" not in capsys.readouterr().err
    assert ("release_all",) in pc_input.calls
    state = json.loads((runtime() / "run-state.json").read_text(encoding="utf-8"))
    assert state["state"] == "stopped"
    assert state["reason"] == "handover"


async def test_the_new_run_opens_the_tv_only_after_it_owns_the_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Com TV configurada: a sessão com a TV (e a marca de conexão, que o agente com TV também
    # grava) é da antiga até ela sair; um comando da API que chega antes é recusado.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.1)
    events: list[str] = []
    attempts = {"n": 0}

    def acquire(base: Path | None = None) -> bool:
        attempts["n"] += 1
        events.append(f"acquire:{attempts['n'] >= 3}")
        return attempts["n"] >= 3

    monkeypatch.setattr(connection_module, "acquire", acquire)
    remote = FakeTvRemote()
    remote.on_connect = lambda: events.append("tv-connect")
    pair_fake_tv(monkeypatch, remote)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        events.append("hello")
        await connection.send(
            dump(envelope("tv.wake.v1", {}, id="0192f1e4-0000-7000-8000-0000000000e1"))
        )
        # O primeiro foi recusado (a TV ainda é da antiga); já como dona, o seguinte a acorda.
        await asyncio.sleep(0.8)
        await connection.send(
            dump(envelope("tv.wake.v1", {}, id="0192f1e4-0000-7000-8000-0000000000e2"))
        )
        await asyncio.sleep(1.2)
        await connection.close(4403, "revoked")

    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url,
            agent_id=AGENT_ID,
            allow_insecure=True,
            tv_host=TV_HOST,
            pc_control=False,
            update_handover=True,
        )
        code = await run(settings, store, handover=True)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert "tv-connect" in events
    assert events.index("hello") < events.index("acquire:True") < events.index("tv-connect")
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert marker["connectedAt"] <= marker["readyAt"]


async def test_a_drop_between_the_local_send_and_the_admission_keeps_the_run_a_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A 1ª conexão cai logo depois de o hello sair (a API nunca o leu); a reconexão tem de voltar
    # como candidata, com o cabeçalho e o hello de passagem, e nunca como conexão comum, que tiraria
    # a antiga do lugar. Só a confirmação da API encerra a candidatura.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    hellos: list[dict[str, Any]] = []

    async def script(connection: ServerConnection) -> None:
        hello = json.loads(await connection.recv())
        hellos.append(hello)
        if len(hellos) == 1:
            await connection.close(1011, "caiu antes da admissão")
            return
        await accept(connection, hello)
        await asyncio.sleep(1.0)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert api.paths == [CANDIDATE_PATH, CANDIDATE_PATH]
    assert [h["body"].get("handover") for h in hellos] == [True, True]
    assert hellos[0]["body"]["instanceId"] == hellos[1]["body"]["instanceId"]
    # "Conectou" para o supervisor é a confirmação (a 2ª conexão a recebeu): ela grava a marca.
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert {"connectedAt", "readyAt"} <= set(marker)


async def test_without_the_confirmation_the_supervisor_has_no_connected_mark(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A API leu o hello mas nunca confirma: o agente não marca "conectou" (o supervisor, que exige
    # a marca em 60 s, encerra e bloqueia a versão nova) e segue se apresentando como candidata.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: False)
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "HANDOVER_CONFIRM_SECONDS", 0.5)

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(3.0)

    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 15)
    assert code == 5
    assert not (runtime() / "connected.json").exists()


async def test_a_shutdown_step_that_never_ends_does_not_hold_the_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "SHUTDOWN_STEP_SECONDS", 0.2)

    async def never() -> None:
        await asyncio.Event().wait()

    started = time.monotonic()
    await connection_module._close_within("um passo que nunca fecha", never())
    assert time.monotonic() - started < 2.0

    async def broken() -> None:
        raise RuntimeError("falhou")

    # Uma falha também é registrada e não impede o resto do encerramento.
    await connection_module._close_within("um passo que falha", broken())


# ---- 4409 depois do ACK, hello da TV e janela `agent_starting` da passagem ----


def ready_mark_written() -> bool:
    path = runtime() / "connected.json"
    try:
        return "readyAt" in json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return False


async def wait_until(condition: Callable[[], bool], seconds: float = 10.0) -> None:
    end = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < end, "a condição não veio a tempo"
        await asyncio.sleep(0.02)


async def next_frame(connection: ServerConnection, frame_type: str, seen: list[Any]) -> Any:
    """Lê os quadros do agente até o do tipo pedido (guarda todos em `seen`)."""
    async with asyncio.timeout(10):
        while True:
            frame = json.loads(await connection.recv())
            seen.append(frame)
            if frame["type"] == frame_type:
                return frame


def pc_input_patch(monkeypatch: pytest.MonkeyPatch, pc_input: FakeInput, **options: Any) -> None:
    monkeypatch.setattr(
        connection_module,
        "build_pc",
        partial(
            build_pc,
            platform="win32",
            pc_input=pc_input,
            power=FakePower(),
            launcher=FakeLauncher(),
            **options,
        ),
    )


KILLED_OLD = {"state": "running", "pid": 1, "version": "0", "startedAt": "2026-11-10T00:00:00Z"}
ORDERLY_OLD = {"state": "stopped", "reason": "handover"}


@pytest.mark.parametrize(
    ("previous", "isolate_input", "releases"),
    [
        (KILLED_OLD, False, 1),
        (KILLED_OLD, True, 1),
        (ORDERLY_OLD, False, 0),
        (None, False, 0),
    ],
    ids=["old-killed", "old-killed-input-thread", "old-left-in-order", "no-trace"],
)
async def test_the_new_run_lets_go_of_what_the_old_one_left_pressed_only_if_it_was_not_orderly(
    monkeypatch: pytest.MonkeyPatch,
    previous: dict[str, Any] | None,
    isolate_input: bool,
    releases: int,
) -> None:
    # Numa saída ordenada a antiga solta o que apertou; o que está apertado depois dela pode ser de
    # uma pessoa de verdade. Só quando ela foi derrubada ou morreu (o rastro ficou `running`) a nova
    # solta o que ela deixou.
    if previous is not None:
        runtime().mkdir(parents=True, exist_ok=True)
        (runtime() / "run-state.json").write_text(json.dumps(previous), encoding="utf-8")
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    pc_input = FakeInput()
    pc_input_patch(monkeypatch, pc_input, isolate_input=isolate_input)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await wait_until(ready_mark_written)
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "A"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000f1",
                )
            )
        )
        await next_frame(connection, "command.result.v1", [])
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    kinds = [call[0] for call in pc_input.calls]
    # Solto uma vez, e antes do primeiro comando da nova dona (a faixa é uma fila só).
    assert kinds.count("release_orphans") == releases
    if releases:
        assert kinds.index("release_orphans") < kinds.index("key")


async def test_a_run_that_is_not_a_handover_never_lets_go_of_what_it_did_not_press(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pc_input = FakeInput()
    pc_input_patch(monkeypatch, pc_input)

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(0.4)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await run(settings_for(api), store)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert ("release_orphans",) not in pc_input.calls


async def test_the_new_run_serves_the_pc_while_the_folder_is_tidied_in_the_background(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A arrumação da pasta (até 60 s) não segura mais a recusa `agent_starting`: o dono a abre logo
    # depois da trava.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    tidying = threading.Event()
    release = threading.Event()

    def slow_tidy(base: Path) -> None:
        tidying.set()
        release.wait(5)

    monkeypatch.setattr(connection_module, "tidy", slow_tidy)
    pc_input = FakeInput()
    pc_input_patch(monkeypatch, pc_input)
    seen: list[Any] = []

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await wait_until(ready_mark_written)
        await wait_until(tidying.is_set)
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "B"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000f2",
                )
            )
        )
        result = await next_frame(connection, "command.result.v1", seen)
        # Respondido com a arrumação ainda em curso: o comando foi atendido, não recusado.
        assert not release.is_set()
        assert result["body"]["ok"] is True
        release.set()
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    try:
        async with FakeApi(script) as api:
            code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    finally:
        release.set()
    assert code == EXIT_CREDENTIAL_REJECTED
    assert any(call[:2] == ("key", "B") for call in pc_input.calls)


def slow_tv_prepare(
    monkeypatch: pytest.MonkeyPatch, gate: asyncio.Event, *, fail: bool = False
) -> None:
    """Acrescenta ao preparo da TV um passo que espera `gate` e então declara uma capacidade (ou
    falha)."""
    real_build_tv = build_tv

    def build_tv_with_slow_prepare(*args: Any, **kwargs: Any) -> Any:
        setup = real_build_tv(*args, **kwargs)
        assert setup is not None

        async def prepare() -> None:
            await gate.wait()
            if fail:
                raise RuntimeError("o ADB falhou")
            setup.capabilities.append("tv.focus-catalog.v1")

        setup.prepare.append(prepare)
        return setup

    monkeypatch.setattr(connection_module, "build_tv", build_tv_with_slow_prepare)


def tv_settings(api: FakeApi) -> Settings:
    return Settings(
        api_url=api.http_url,
        agent_id=AGENT_ID,
        allow_insecure=True,
        tv_host=TV_HOST,
        pc_control=True,
        update_handover=True,
    )


async def test_the_tv_capabilities_reach_the_api_as_soon_as_the_tv_prepare_ends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # O preparo da TV declara capacidades DEPOIS do `hello` da candidata: sem o reenvio elas só
    # chegariam no `hello` periódico (até 5 minutos). Enquanto ele não termina, os comandos `tv.*`
    # são recusados e o PC já atende.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    pair_fake_tv(monkeypatch, FakeTvRemote())
    pc_input = FakeInput()
    pc_input_patch(monkeypatch, pc_input)
    gate = asyncio.Event()
    slow_tv_prepare(monkeypatch, gate)
    seen: list[Any] = []
    hellos: list[dict[str, Any]] = []

    async def script(connection: ServerConnection) -> None:
        first = json.loads(await connection.recv())
        hellos.append(first)
        await accept(connection, first)
        await wait_until(ready_mark_written)
        await connection.send(
            dump(envelope("tv.wake.v1", {}, id="0192f1e4-0000-7000-8000-0000000000a1"))
        )
        refused = await next_frame(connection, "command.result.v1", seen)
        assert refused["body"]["error"]["code"] == "agent_starting"
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "C"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000a2",
                )
            )
        )
        served = await next_frame(connection, "command.result.v1", seen)
        assert served["body"]["ok"] is True
        gate.set()
        hellos.append(await next_frame(connection, "agent.hello.v1", seen))
        await connection.send(
            dump(envelope("tv.wake.v1", {}, id="0192f1e4-0000-7000-8000-0000000000a3"))
        )
        after = await next_frame(connection, "command.result.v1", seen)
        assert after["body"].get("error", {}).get("code") != "agent_starting"
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(tv_settings(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert "tv.focus-catalog.v1" not in hellos[0]["body"]["capabilities"]
    assert "tv.focus-catalog.v1" in hellos[1]["body"]["capabilities"]
    # O reenvio sai já como dona: a candidatura acabou (a API confirmou) e o hello é comum.
    assert "handover" not in hellos[1]["body"]


async def test_a_tv_prepare_that_takes_too_long_does_not_hold_the_tv_and_still_ends_in_a_hello(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "HANDOVER_TV_PREPARE_SECONDS", 0.3)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    pair_fake_tv(monkeypatch, FakeTvRemote())
    pc_input_patch(monkeypatch, FakeInput())
    gate = asyncio.Event()
    slow_tv_prepare(monkeypatch, gate)
    seen: list[Any] = []
    hellos: list[dict[str, Any]] = []

    async def script(connection: ServerConnection) -> None:
        first = json.loads(await connection.recv())
        hellos.append(first)
        await accept(connection, first)
        await wait_until(ready_mark_written)
        await asyncio.sleep(1.0)  # passou o prazo do preparo: a TV segue sem ele
        await connection.send(
            dump(envelope("tv.wake.v1", {}, id="0192f1e4-0000-7000-8000-0000000000b1"))
        )
        late = await next_frame(connection, "command.result.v1", seen)
        assert late["body"].get("error", {}).get("code") != "agent_starting"
        # O preparo termina depois do prazo: a capacidade que ele declara ainda vai ao `hello`.
        gate.set()
        hellos.append(await next_frame(connection, "agent.hello.v1", seen))
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(tv_settings(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert "tv.focus-catalog.v1" in hellos[1]["body"]["capabilities"]


async def test_a_tv_prepare_that_fails_never_takes_the_new_owner_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    pair_fake_tv(monkeypatch, FakeTvRemote())
    pc_input_patch(monkeypatch, FakeInput())
    gate = asyncio.Event()
    gate.set()
    slow_tv_prepare(monkeypatch, gate, fail=True)
    seen: list[Any] = []

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await wait_until(ready_mark_written)
        await asyncio.sleep(0.5)
        await connection.send(
            dump(
                envelope(
                    "pc.key.v1",
                    {"key": "D"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000b2",
                )
            )
        )
        result = await next_frame(connection, "command.result.v1", seen)
        assert result["body"]["ok"] is True
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(tv_settings(api), store, handover=True), 30)
    # Saiu pela credencial recusada (o fim do roteiro), não por uma falha do preparo da TV.
    assert code == EXIT_CREDENTIAL_REJECTED


async def test_a_4409_after_the_confirmation_brings_the_candidate_back_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Um deploy da API no meio da passagem: a nova, já confirmada mas ainda sem a trava, é tirada
    # do lugar com 4409. Em vez de esperar 60 s sem agente nenhum, volta na hora como candidata.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: False)
    hellos: list[dict[str, Any]] = []

    async def script(connection: ServerConnection) -> None:
        hello = json.loads(await connection.recv())
        hellos.append(hello)
        await accept(connection, hello)
        if len(hellos) == 1:
            await asyncio.sleep(0.2)
            await connection.close(4409, "replaced")
            return
        await asyncio.sleep(0.5)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    started = time.monotonic()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert time.monotonic() - started < 20
    assert api.paths == [CANDIDATE_PATH, CANDIDATE_PATH]
    assert [h["body"].get("handover") for h in hellos] == [True, True]
    assert hellos[0]["body"]["instanceId"] == hellos[1]["body"]["instanceId"]


@pytest.mark.parametrize("isolate_input", [False, True], ids=["same-loop", "input-thread"])
async def test_the_old_run_exits_in_an_orderly_way_when_the_supervisor_asks_for_it(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], isolate_input: bool
) -> None:
    # A API não a mandou sair (ou o 4410 não chegou): o supervisor deixa o pedido em `runtime\` e
    # ela termina como no 4410, sem esperar a derrubada.
    pc_input = FakeInput()
    pc_input_patch(monkeypatch, pc_input, isolate_input=isolate_input)

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await connection.send(
            dump(
                envelope(
                    "pc.key.v2",
                    {"key": "ALT", "action": "DOWN"},
                    ts=now_stamp(),
                    id="0192f1e4-0000-7000-8000-0000000000d2",
                )
            )
        )
        await asyncio.sleep(0.4)
        (runtime() / "handover-exit").write_text("handover-exit:" + "c" * 32, encoding="ascii")
        # Quem fecha o canal é o agente, ao sair; sem isso o roteiro esperaria o teste inteiro.
        async with asyncio.timeout(15):
            await connection.wait_closed()

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store), 20)
    assert code == EXIT_OK
    assert api.connections == 1
    assert "Token revogado" not in capsys.readouterr().err
    assert ("release_all",) in pc_input.calls
    state = json.loads((runtime() / "run-state.json").read_text(encoding="utf-8"))
    assert (state["state"], state["reason"]) == ("stopped", "handover")


async def test_a_request_left_over_from_a_passage_that_did_not_end_is_dropped_on_start() -> None:
    runtime().mkdir(parents=True, exist_ok=True)
    stale = runtime() / "handover-exit"
    stale.write_text("handover-exit:" + "d" * 32, encoding="ascii")

    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(1.5)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store), 20)
    # Nenhuma saída ordenada: o agente seguiu até o fim do roteiro, e o arquivo velho foi apagado.
    assert code == EXIT_CREDENTIAL_REJECTED
    assert not stale.exists()


@pytest.mark.parametrize(
    ("token", "expected"),
    [("e" * 32, EXIT_CREDENTIAL_REJECTED), ("f" * 32, EXIT_OK)],
    ids=["its-own-code", "another-code"],
)
async def test_the_new_run_ignores_the_exit_request_with_its_own_code_and_obeys_another(
    monkeypatch: pytest.MonkeyPatch, token: str, expected: int
) -> None:
    # A execução da passagem segue de pé como o agente: na próxima passagem ela é a antiga, e o
    # pedido que leva o código DELA (a passagem que a trouxe) não é para ela.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: True)
    monkeypatch.setenv("UNIOVER_WINDOW_TOKEN", "e" * 32)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await wait_until(ready_mark_written)
        (runtime() / "handover-exit").write_text("handover-exit:" + token, encoding="ascii")
        await asyncio.sleep(3.0)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == expected


@pytest.mark.parametrize(
    "content",
    [
        "",
        "handover-exit:",
        "handover-exit:abc",
        "c" * 32,
        "handover-exit:" + "C" * 32,
        "handover-exit:" + "c" * 32 + "\n",
        "handover-exit:" + "c" * 31,
    ],
    ids=["empty", "no-code", "short-code", "no-prefix", "uppercase", "newline", "partial"],
)
async def test_a_malformed_exit_request_never_takes_the_agent_down(content: str) -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(0.3)
        (runtime() / "handover-exit").write_text(content, encoding="ascii")
        await asyncio.sleep(1.5)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store), 20)
    # Seguiu até o fim do roteiro: nenhuma saída ordenada.
    assert code == EXIT_CREDENTIAL_REJECTED


async def test_an_exit_request_older_than_the_run_is_ignored() -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.recv()
        await asyncio.sleep(0.3)
        path = runtime() / "handover-exit"
        path.write_text("handover-exit:" + "c" * 32, encoding="ascii")
        past = time.time() - 3600
        os.utime(path, (past, past))  # gravado antes de esta execução existir
        await asyncio.sleep(1.5)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store), 20)
    assert code == EXIT_CREDENTIAL_REJECTED


async def test_the_new_owner_needs_the_confirmation_of_the_current_candidacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ACK e 4409 logo depois: a confirmação da 1ª conexão não vale mais. Com a trava livre a nova só
    # vira dona quando a API confirmar a candidatura de agora (a 2ª conexão).
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    gate = threading.Event()
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: gate.is_set())
    hellos: list[dict[str, Any]] = []
    observed: dict[str, bool] = {}

    async def script(connection: ServerConnection) -> None:
        hello = json.loads(await connection.recv())
        hellos.append(hello)
        if len(hellos) == 1:
            await accept(connection, hello)
            await asyncio.sleep(0.2)
            await connection.close(4409, "replaced")
            return
        gate.set()  # a trava está livre; falta só a confirmação desta candidatura
        await asyncio.sleep(1.0)
        observed["owner_without_confirmation"] = ready_mark_written()
        await accept(connection, hello)
        await wait_until(ready_mark_written)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert observed == {"owner_without_confirmation": False}


async def test_the_lock_deadline_counts_from_the_confirmation_of_the_current_candidacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ACK, 4409 e uma 2ª confirmação que só vem depois de o prazo da trava (contado da 1ª) passar:
    # o prazo recomeça com a confirmação de agora, e a trava que chega a tempo ainda vale.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setenv(connection_module.HANDOVER_TAKEOVER_SECONDS_ENV, "1.0")
    gate = threading.Event()
    monkeypatch.setattr(connection_module, "acquire", lambda base=None: gate.is_set())
    hellos: list[dict[str, Any]] = []
    confirmations: list[str] = []

    def connected_at() -> str | None:
        try:
            mark = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
        except OSError, ValueError:
            return None
        return str(mark.get("connectedAt"))

    async def script(connection: ServerConnection) -> None:
        hello = json.loads(await connection.recv())
        hellos.append(hello)
        if len(hellos) == 1:
            await accept(connection, hello)
            await wait_until(lambda: connected_at() is not None)
            confirmations.append(str(connected_at()))
            await asyncio.sleep(0.1)
            await connection.close(4409, "replaced")
            return
        await asyncio.sleep(1.3)  # mais que o prazo da trava, contado da 1ª confirmação
        await accept(connection, hello)
        await wait_until(lambda: connected_at() != confirmations[0])
        confirmations.append(str(connected_at()))
        await asyncio.sleep(0.3)
        gate.set()
        await wait_until(ready_mark_written)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 30)
    assert code == EXIT_CREDENTIAL_REJECTED
    assert len(confirmations) == 2 and confirmations[1] > confirmations[0]
