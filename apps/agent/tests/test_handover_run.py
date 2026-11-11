"""Passagem sem queda de ponta a ponta: `run --handover` e a execução antiga que é substituída.

O servidor falso faz o papel da API: lê o `hello`, fecha com o código que a API usaria e confere o
que o agente disse. Nada aqui toca na instalação real (a pasta é a do teste).
"""

import asyncio
import json
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

    def announce(*args: Any, **kwargs: Any) -> None:
        events.append("announce_start")
        announce_start(*args, **kwargs)

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

    def announce(*args: Any, **kwargs: Any) -> None:
        started.append(True)
        announce_start(*args, **kwargs)

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


async def test_after_the_confirmation_the_new_run_never_gives_up_waiting_for_the_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A API já promoveu esta execução e mandou a antiga sair (que não reconecta): desistir agora
    # deixaria o PC sem agente. A trava demora bem mais que o prazo de confirmação e a nova ainda
    # assim vira a dona quando ela vem.
    monkeypatch.setattr(connection_module, "fetch_api_features", features_of(LISTED))
    monkeypatch.setattr(connection_module, "HANDOVER_POLL_SECONDS", 0.05)
    monkeypatch.setattr(connection_module, "HANDOVER_CONFIRM_SECONDS", 0.2)
    monkeypatch.setattr(connection_module, "HANDOVER_WAIT_LOG_SECONDS", 0.1)
    first_try: list[float] = []

    def acquire(base: Path | None = None) -> bool:
        if not first_try:
            first_try.append(time.monotonic())
        return time.monotonic() - first_try[0] >= 0.9

    monkeypatch.setattr(connection_module, "acquire", acquire)
    monkeypatch.setattr(connection_module, "acquire_slug", lambda agent_id: True)

    async def script(connection: ServerConnection) -> None:
        await accept(connection, json.loads(await connection.recv()))
        await asyncio.sleep(2.0)
        await connection.close(4403, "revoked")

    silence_noisy_loggers()
    async with FakeApi(script) as api:
        code = await asyncio.wait_for(run(settings_for(api), store, handover=True), 15)
    assert code == EXIT_CREDENTIAL_REJECTED
    marker = json.loads((runtime() / "connected.json").read_text(encoding="utf-8"))
    assert {"connectedAt", "readyAt"} <= set(marker)
    state = json.loads((runtime() / "run-state.json").read_text(encoding="utf-8"))
    assert state["reason"] == "credencial_recusada"


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
