"""O ADB aberto sem a pessoa: curto, provado pela sonda e sempre desconectado no fim.

Nenhum teste fala com uma TV: o `adb` é o `FakeAdbRunner`, a sonda e a conferência da chave são
funções do teste e a pasta `.android` é de mentira (`Home`). O que se confere em cada caso é o
`argv` que chegou ao `adb`: sem `connect` nada pode abrir o aviso "Permitir depuração USB" na TV, e
sem o `disconnect` do fim o servidor do `adb` religaria a conexão sozinho depois de a TV revogar a
chave.
"""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.adb_authorization import NEEDS_USER, VERIFIED
from uniover_agent.adapters.tv_adb import AdbTv
from uniover_agent.core.tv.adb_permission import AdbPermissionTracker
from uniover_agent.ports import (
    PROBE_AUTHORIZED,
    PROBE_EVENT_HOST_NOT_NUMERIC,
    PROBE_EVENT_KEY_CHANGED,
    PROBE_EVENT_KEY_UNVERIFIABLE,
    PROBE_EVENT_MAC_CHANGED,
    PROBE_EVENT_MISMATCH,
    PROBE_SKIPPED,
    PROBE_TLS_REQUIRED,
    PROBE_UNAUTHORIZED,
    PROBE_UNKNOWN,
    PROBE_UNREACHABLE,
    AdbDeviceChanged,
    AdbIdle,
    AdbUnauthorized,
    AdbUnreachable,
    ProbeVerdict,
    user_initiated_adb,
)

from .support_adb import ADB, CONNECT, DISCONNECT, GET_STATE, FakeAdbRunner, ok
from .test_tv_adb_permission import DEVICE, MAC, OTHER_MAC, UNKNOWN, Home, runner_with

FINGERPRINT = "digital-da-chave-que-assinou"


class Gate:
    """A sonda e a conferência da chave do teste, e o que o adaptador contou ao diagnóstico."""

    def __init__(self, verdict: str = PROBE_AUTHORIZED) -> None:
        self.verdict = verdict
        self.probes = 0
        self.key_reason: str | None = None
        self.key_checks: list[str | None] = []
        self.events: list[str] = []
        self.on_probe: Any = None

    async def probe(self) -> ProbeVerdict:
        self.probes += 1
        if self.on_probe is not None:
            self.on_probe()
        return ProbeVerdict(self.verdict, FINGERPRINT if self.verdict == PROBE_AUTHORIZED else None)

    async def key_check(self, expected: str | None) -> str | None:
        self.key_checks.append(expected)
        return self.key_reason

    def adb_args(self) -> dict[str, Any]:
        return {
            "silent_clearance": self.probe,
            "key_check": self.key_check,
            "on_probe_event": self.events.append,
        }


@pytest.fixture
def home(tmp_path: Path) -> Home:
    house = Home(tmp_path)
    house.write_key()
    house.active = False  # ninguém usando a TV pelo app: o caso do religamento sozinho
    return house


def calls_of(runner: FakeAdbRunner, wanted: tuple[str, ...]) -> int:
    return sum(1 for call in runner.calls if call == wanted)


def record_state(home: Home) -> str:
    return str(json.loads((home.state / "adb-authorization.json").read_text("utf-8"))["state"])


def make(
    home: Home, runner: FakeAdbRunner, gate: Gate, *, settled: bool = False, **extra: Any
) -> AdbTv:
    return home.adb(runner, authorization=home.verify(settled=settled), **gate.adb_args(), **extra)


# --- curta duração: sempre desconecta ---------------------------------------------------------


async def test_an_authorized_probe_connects_without_anyone_using_the_tv_and_disconnects_at_the_end(
    home: Home,
) -> None:
    gate = Gate()
    runner = runner_with()
    tracker = AdbPermissionTracker()
    adb = make(home, runner, gate, permission=tracker)
    async with adb.unattended():
        assert adb.connected
        assert calls_of(runner, DISCONNECT) == 0  # aberto: a leitura acontece agora
    assert not adb.connected
    assert gate.probes == 1
    assert calls_of(runner, CONNECT) == 1
    assert calls_of(runner, DISCONNECT) == 1
    assert gate.key_checks == [FINGERPRINT]  # a chave provada foi conferida antes do `connect`
    assert tracker.state == "granted"


async def test_the_transport_is_disconnected_even_when_the_work_inside_fails(home: Home) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate())
    with pytest.raises(RuntimeError):
        async with adb.unattended():
            raise RuntimeError("a leitura quebrou")
    assert not adb.connected
    assert calls_of(runner, DISCONNECT) == 1


async def test_the_transport_is_disconnected_when_the_task_is_cancelled(home: Home) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate())
    inside = asyncio.Event()

    async def hold() -> None:
        async with adb.unattended():
            inside.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(hold())
    await inside.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls_of(runner, DISCONNECT) == 1
    assert not adb.connected


async def test_a_connect_that_timed_out_is_disconnected_too(home: Home) -> None:
    runner = runner_with(connect=TimeoutError())
    adb = make(home, runner, Gate())
    with pytest.raises(AdbUnreachable):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert calls_of(runner, CONNECT) == 1
    assert calls_of(runner, DISCONNECT) == 1  # o `connect` pode ter deixado o transporte
    assert not adb.connected


async def test_a_connect_that_found_nobody_is_disconnected_too(home: Home) -> None:
    runner = runner_with(connect=ok("cannot connect to 192.168.1.6:5555: timed out\r\n"))
    adb = make(home, runner, Gate())
    with pytest.raises(AdbUnreachable):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert calls_of(runner, DISCONNECT) == 1


async def test_a_refusal_before_the_connect_has_nothing_to_disconnect(home: Home) -> None:
    runner = runner_with(state=UNKNOWN)  # nenhum transporte no servidor do `adb`
    adb = make(home, runner, Gate(PROBE_UNREACHABLE))
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert calls_of(runner, CONNECT) == 0
    assert calls_of(runner, DISCONNECT) == 0


async def test_hibernation_never_keeps_a_transport_that_was_opened_without_the_person(
    home: Home,
) -> None:
    # Com a permissão provada e o vencimento desligado, um canal da pessoa FICA; o sem ela, não.
    runner = runner_with()
    adb = make(home, runner, Gate(), settled=True)
    async with adb.unattended():
        await adb.disconnect()
        assert not adb.connected
        assert calls_of(runner, DISCONNECT) == 1
    assert calls_of(runner, DISCONNECT) == 2  # e o fim da abertura ainda confere o seu


async def test_closing_the_agent_never_keeps_a_transport_opened_without_the_person(
    home: Home,
) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate(), settled=True)
    async with adb.unattended():
        await adb.aclose()
        assert calls_of(runner, DISCONNECT) == 1


async def test_a_channel_the_person_opened_is_used_and_never_disconnected(home: Home) -> None:
    home.active = True
    gate = Gate()
    runner = runner_with()
    adb = make(home, runner, gate, settled=True)
    await adb.connect()  # a pessoa está usando a TV: o canal dela
    assert adb.connected
    async with adb.unattended():
        assert adb.connected
    assert adb.connected  # continua do dono
    assert gate.probes == 0  # nem sonda nem conexão nova
    assert calls_of(runner, CONNECT) == 1
    assert calls_of(runner, DISCONNECT) == 0


async def test_the_person_does_not_inherit_the_transport_of_an_unattended_opening(
    home: Home,
) -> None:
    gate = Gate()
    runner = runner_with()
    adb = make(home, runner, gate, settled=True)
    async with adb.unattended():
        home.active = True
        # A pessoa chega com a abertura ainda aberta e usa o canal; ao fim ele é desconectado.
        assert adb.connected
    assert not adb.connected
    assert calls_of(runner, DISCONNECT) == 1


# --- transporte que já existe no servidor do adb --------------------------------------------------


@pytest.mark.parametrize("verdict", [PROBE_UNAUTHORIZED, PROBE_SKIPPED, PROBE_UNKNOWN])
async def test_an_existing_transport_is_never_adopted_without_an_authorized_probe(
    home: Home, verdict: str
) -> None:
    gate = Gate(verdict)
    runner = runner_with(state=DEVICE)
    tracker = AdbPermissionTracker()
    # Provada e com o vencimento desligado: sem a pessoa, um transporte vivo era adotado antes.
    adb = make(home, runner, gate, settled=True, permission=tracker)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert not adb.connected
    assert calls_of(runner, CONNECT) == 0
    assert calls_of(runner, DISCONNECT) == 1  # o que não é do agente é desfeito
    assert record_state(home) == VERIFIED
    assert tracker.state is None


async def test_the_tv_that_accepts_the_adb_key_but_not_the_probe_key_is_a_mismatch(
    home: Home,
) -> None:
    gate = Gate(PROBE_UNAUTHORIZED)
    runner = runner_with(state=DEVICE)
    adb = make(home, runner, gate, settled=True)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.events == [PROBE_EVENT_MISMATCH]
    assert calls_of(runner, DISCONNECT) == 1


@pytest.mark.parametrize("verdict", [PROBE_SKIPPED, PROBE_UNREACHABLE, PROBE_TLS_REQUIRED])
async def test_only_an_unauthorized_probe_against_an_accepting_adb_is_a_mismatch(
    home: Home, verdict: str
) -> None:
    gate = Gate(verdict)
    adb = make(home, runner_with(state=DEVICE), gate, settled=True)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.events == []


async def test_outside_an_unattended_opening_the_old_adoption_of_a_live_transport_is_unchanged(
    home: Home,
) -> None:
    # A pessoa está longe (portão fechado por falta de uso), a permissão é provada e há um
    # transporte vivo: os caminhos de sempre o adotam, sem `connect` e sem sonda.
    runner = runner_with(state=DEVICE)
    gate = Gate()
    adb = make(home, runner, gate, settled=True)
    await adb.connect()
    assert adb.connected
    assert calls_of(runner, CONNECT) == 0
    assert gate.probes == 0


# --- a sonda e o que ela libera --------------------


@pytest.mark.parametrize(
    "verdict",
    [PROBE_UNAUTHORIZED, PROBE_TLS_REQUIRED, PROBE_UNKNOWN, PROBE_UNREACHABLE, PROBE_SKIPPED],
)
async def test_any_other_verdict_never_runs_adb_connect(home: Home, verdict: str) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate(verdict))
    with pytest.raises((AdbIdle, AdbUnauthorized)):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert not adb.connected
    assert calls_of(runner, CONNECT) == 0


async def test_unauthorized_is_the_tv_refusing_the_key_and_the_state_follows_the_code_that_exists(
    home: Home,
) -> None:
    runner = runner_with(state=UNKNOWN)  # a TV ainda não aceita o adb: é recusa dela
    tracker = AdbPermissionTracker()
    adb = make(home, runner, Gate(PROBE_UNAUTHORIZED), permission=tracker)
    with pytest.raises(AdbUnauthorized):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert calls_of(runner, CONNECT) == 0
    # Como toda recusa da TV: o registro pede a pessoa e o app fica sabendo.
    assert record_state(home) == NEEDS_USER
    assert tracker.state == "missing"
    assert tracker.reason == "tv_forgot"


@pytest.mark.parametrize(
    "verdict", [PROBE_TLS_REQUIRED, PROBE_UNKNOWN, PROBE_UNREACHABLE, PROBE_SKIPPED]
)
async def test_a_verdict_that_says_nothing_about_the_permission_changes_nothing(
    home: Home, verdict: str
) -> None:
    tracker = AdbPermissionTracker()
    adb = make(home, runner_with(), Gate(verdict), permission=tracker)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert record_state(home) == VERIFIED
    assert tracker.state is None


async def test_without_a_probe_or_a_key_check_nothing_connects(home: Home) -> None:
    gate = Gate()
    for extra in (
        {"key_check": gate.key_check},  # sem sonda
        {"silent_clearance": gate.probe},  # sem a conferência da chave
        {},
    ):
        runner = runner_with()
        adb = home.adb(runner, authorization=home.verify(settled=True), **extra)
        with pytest.raises(AdbIdle):
            async with adb.unattended():
                raise AssertionError("não deve abrir")
        assert runner.calls == []


async def test_the_registry_gates_stay_and_the_probe_is_not_spent_on_a_tv_that_never_granted(
    home: Home,
) -> None:
    gate = Gate()
    runner = runner_with(state=DEVICE)
    # Só `granted`, sem a prova de um toque da pessoa: o portão do registro continua fechado.
    authorization = home.authorization()
    authorization.mark_granted(authorization.snapshot_key(), MAC)
    adb = home.adb(runner, authorization=authorization, **gate.adb_args())
    with pytest.raises(AdbUnauthorized):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.probes == 0
    assert calls_of(runner, CONNECT) == 0


async def test_another_device_at_the_address_is_not_probed_nor_connected(home: Home) -> None:
    gate = Gate()
    runner = runner_with()
    adb = home.adb(runner, authorization=home.verify(MAC), **gate.adb_args())
    home.mac = OTHER_MAC
    with pytest.raises(AdbDeviceChanged):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.probes == 0
    assert calls_of(runner, CONNECT) == 0


async def test_a_tv_that_does_not_answer_on_the_network_is_not_probed(home: Home) -> None:
    gate = Gate()
    runner = runner_with()
    adb = make(home, runner, gate)
    home.mac = None
    with pytest.raises(AdbUnreachable):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.probes == 0
    assert calls_of(runner, CONNECT) == 0


async def test_the_waiver_of_presence_ends_with_the_block(home: Home) -> None:
    gate = Gate()
    runner = runner_with()
    adb = make(home, runner, gate)
    async with adb.unattended():
        pass
    # Uma conexão comum, sem a pessoa, continua pedindo a presença (e não consulta a sonda).
    with pytest.raises(AdbIdle):
        await adb.connect()
    assert gate.probes == 1
    assert calls_of(runner, CONNECT) == 1


async def test_a_refusal_resets_the_waiver_too(home: Home) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate(PROBE_SKIPPED))
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    with pytest.raises(AdbIdle):
        await adb.connect()
    assert calls_of(runner, CONNECT) == 0


async def test_a_users_request_never_asks_the_probe(home: Home) -> None:
    gate = Gate(PROBE_UNAUTHORIZED)
    runner = runner_with()
    adb = make(home, runner, gate)
    with user_initiated_adb():
        await adb.connect()
    assert gate.probes == 0
    assert calls_of(runner, CONNECT) >= 1


async def test_with_the_presence_of_the_owner_the_old_rule_still_applies_without_a_probe(
    home: Home,
) -> None:
    runner = runner_with()
    home.active = True
    adb = home.adb(runner, authorization=home.verify())
    await adb.connect()
    assert adb.connected
    assert calls_of(runner, CONNECT) == 1


def test_the_get_state_script_is_the_authorized_one() -> None:
    # Guarda dos roteiros acima: `runner_with()` entrega `device` ao `get-state`.
    assert runner_with().script[GET_STATE] == DEVICE
    assert ADB


# --- a chave: a que a sonda provou é a que o adb usa --------------------------------------------


@pytest.mark.parametrize("reason", [PROBE_EVENT_KEY_CHANGED, "key_stale", "vendor_keys"])
async def test_a_key_that_is_no_longer_the_proven_one_stops_the_connect(
    home: Home, reason: str
) -> None:
    gate = Gate()
    gate.key_reason = reason
    runner = runner_with()
    adb = make(home, runner, gate)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.probes == 1
    assert gate.key_checks == [FINGERPRINT]
    assert gate.events == [reason]
    assert calls_of(runner, CONNECT) == 0
    assert record_state(home) == VERIFIED  # nada se grava: a permissão não se perdeu


async def test_a_key_check_that_crashes_stops_the_connect(home: Home) -> None:
    gate = Gate()

    async def broken(expected: str | None) -> str | None:
        raise RuntimeError("falha")

    runner = runner_with()
    adb = home.adb(
        runner,
        authorization=home.verify(),
        silent_clearance=gate.probe,
        key_check=broken,
        on_probe_event=gate.events.append,
    )
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.events == [PROBE_EVENT_KEY_UNVERIFIABLE]
    assert calls_of(runner, CONNECT) == 0


# --- o destino: o mesmo endereço e o mesmo aparelho da sonda ao connect -----------------------


async def test_a_name_instead_of_an_ip_is_never_connected_without_the_person(
    home: Home,
) -> None:
    gate = Gate()
    runner = runner_with()
    adb = AdbTv(
        ADB,
        "tv-da-sala.local",
        5555,
        timeout=1.0,
        runner=runner,
        authorization=home.verify(settled=True),
        mac_resolver=home.resolve,
        user_active=lambda: False,
        **gate.adb_args(),
    )
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.probes == 0
    assert runner.calls == []
    assert gate.events == [PROBE_EVENT_HOST_NOT_NUMERIC]


async def test_another_device_answering_after_the_probe_stops_the_connect(home: Home) -> None:
    gate = Gate()
    gate.on_probe = lambda: setattr(home, "mac", OTHER_MAC)  # a TV trocou de lugar com outra
    runner = runner_with()
    adb = make(home, runner, gate)
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.events == [PROBE_EVENT_MAC_CHANGED]
    assert calls_of(runner, CONNECT) == 0
    assert gate.key_checks == []  # nem chegou na conferência da chave


async def test_another_device_answering_right_before_the_connect_stops_it_too(home: Home) -> None:
    gate = Gate()
    answers = [MAC, MAC, OTHER_MAC]  # o portão, depois da sonda, e logo antes do `adb connect`

    async def resolve() -> str | None:
        return answers.pop(0) if len(answers) > 1 else answers[0]

    runner = runner_with()
    home.resolve = resolve  # type: ignore[method-assign]
    adb = home.adb(runner, authorization=home.verify(), **gate.adb_args())
    with pytest.raises(AdbIdle):
        async with adb.unattended():
            raise AssertionError("não deve abrir")
    assert gate.events == [PROBE_EVENT_MAC_CHANGED]
    assert calls_of(runner, CONNECT) == 0
    assert gate.probes == 1


async def test_the_end_of_the_block_never_drops_the_transport_the_person_opened_meanwhile(
    home: Home,
) -> None:
    runner = runner_with()
    adb = make(home, runner, Gate(), settled=True)
    async with adb.unattended():
        await adb.disconnect()  # a hibernação solta o transporte sem a pessoa
        assert calls_of(runner, DISCONNECT) == 1
        home.active = True
        await adb.connect()  # e a pessoa chega e abre o canal dela, com a presença
        assert adb.connected
    # Ao sair, o canal da pessoa continua de pé e nenhum `disconnect` novo o derrubou.
    assert adb.connected
    assert calls_of(runner, DISCONNECT) == 1
    assert calls_of(runner, CONNECT) == 2
