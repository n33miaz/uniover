"""O ADB aberto sem a pessoa, nos três pontos: TV reencontrada, partida e conferência diária.

A sonda é uma função do teste (nenhum teste abre a porta do ADB de uma TV) e o adaptador é o
dublê `FakeTvAdb`, que como o real só abre com `authorized` e desconecta ao sair. O que se
confere é quando o canal abre sozinho, quando não abre, e que nunca fica aberto.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import ValidationError

from uniover_agent.adapters.adb_silent_probe import ProbeResult, public_key_fingerprint
from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.installation import installation_base
from uniover_agent.composition import tv as tv_module
from uniover_agent.composition.tv import TvSetup, build_tv, tv_is_back
from uniover_agent.config import Settings
from uniover_agent.core import EnvelopeFactory, EnvelopeGate
from uniover_agent.core.tv.wake_settings import SCREENLESS_OFF
from uniover_agent.ports import AdbIdle, WakeSettings

from .support import AGENT_ID
from .test_tv_adb_composition import enable_adb
from .test_tv_composition import TV_HOST, pair_fake_tv

TCL_SCREENLESS_OFF = WakeSettings(tcl=True, screenless=False, power_restore=True)


class TickingClock(FakeClock):
    """O relógio virtual em que a hora de parede anda junto com o monotônico."""

    def now(self) -> datetime:
        return datetime(2026, 11, 14, 12, 0, tzinfo=UTC) + timedelta(seconds=self.monotonic())


class Rig:
    """A TV montada com o dublê do ADB, a sonda do teste e o relógio à mão."""

    def __init__(self, setup: TvSetup, adb: FakeTvAdb, clock: FakeClock) -> None:
        self.setup = setup
        self.adb = adb
        self.clock = clock
        self.verdicts: list[ProbeResult] = [ProbeResult.AUTHORIZED]
        self.probed = 0

    async def probe(
        self,
        host: str,
        port: int,
        loader: object,
        timeout: float = 3.0,  # noqa: ASYNC109 - a mesma assinatura da sonda
    ) -> ProbeResult:
        self.probed += 1
        return self.verdicts.pop(0) if len(self.verdicts) > 1 else self.verdicts[0]

    @property
    def scheduler(self) -> Any:
        assert self.setup.cleanup_scheduler is not None
        return self.setup.cleanup_scheduler

    async def settle(self) -> None:
        # A sonda lê e grava o horário numa thread: a espera precisa deixar a thread andar.
        for _ in range(40):
            await asyncio.sleep(0.01)

    def wake_reads(self) -> int:
        return self.adb.cleanup_log.count("wake-settings")


def build(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **settings: Any) -> Rig:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    adb = FakeTvAdb()
    adb.wake = TCL_SCREENLESS_OFF
    enable_adb(monkeypatch, tmp_path, adb)

    def spying(*args: Any, **kwargs: Any) -> FakeTvAdb:
        # `enable_adb` já trocou o adaptador pelo dublê: guarda a sonda que a composição passou.
        adb.silent_clearance = kwargs.get("silent_clearance")
        return adb

    monkeypatch.setattr(tv_module, "AdbTv", spying)
    clock = TickingClock()
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    setup = build_tv(
        Settings(tv_host=TV_HOST, tv_watchdog=False, **settings),
        clock,
        FakeTransport(),
        envelopes,
    )
    assert setup is not None
    rig = Rig(setup, adb, clock)
    monkeypatch.setattr(tv_module, "silent_adb_probe", rig.probe)
    return rig


async def test_the_daily_check_opens_the_adb_only_after_an_authorized_probe_and_closes_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 1
    assert rig.adb.unattended_connects == 1
    assert rig.wake_reads() == 1
    assert rig.setup.wake_check is not None
    assert rig.setup.wake_check.hints == (SCREENLESS_OFF,)
    # Curta duração: abriu para a leitura e foi desconectado.
    assert rig.adb.connects == 1
    assert rig.adb.disconnects == 1
    assert not rig.adb.connected


@pytest.mark.parametrize(
    "verdict",
    [
        ProbeResult.UNAUTHORIZED,
        ProbeResult.TLS_REQUIRED,
        ProbeResult.UNKNOWN,
        ProbeResult.UNREACHABLE,
    ],
)
async def test_the_daily_check_does_not_connect_nor_read_without_an_authorized_probe(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, verdict: ProbeResult
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.verdicts = [verdict]
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 1
    assert rig.adb.connects == 0
    assert rig.wake_reads() == 0
    assert rig.setup.wake_check is not None
    assert rig.setup.wake_check.hints == ()
    assert rig.setup.adb_link is not None
    assert rig.setup.adb_link.last_result == verdict.value


async def test_the_probe_runs_at_most_once_per_address_every_five_minutes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.verdicts = [ProbeResult.UNREACHABLE, ProbeResult.AUTHORIZED]
    for _ in range(3):  # a sessão abre várias vezes no mesmo dia
        rig.scheduler.note_session_opened(0.1)
        await rig.scheduler.run_pending()
    assert rig.probed == 1
    assert rig.wake_reads() == 0
    rig.clock.advance(300)
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 2
    assert rig.wake_reads() == 1  # a prova veio, o canal abriu para a leitura e fechou


async def test_the_five_minute_window_survives_an_agent_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    first = build(monkeypatch, tmp_path)
    first.verdicts = [ProbeResult.UNREACHABLE]
    first.scheduler.note_session_opened(0.1)
    await first.scheduler.run_pending()
    assert first.probed == 1
    saved = json.loads((installation_base() / "runtime" / "adb-probe.json").read_text("utf-8"))
    assert list(saved["probes"]) == [f"{TV_HOST}:5555"]  # o endereço canônico, sem nada além
    # O agente reinicia (peças novas, relógio monotônico recomeçando, o mesmo disco).
    second = build(monkeypatch, tmp_path / "segunda")
    second.scheduler.note_session_opened(0.1)
    await second.scheduler.run_pending()
    assert second.probed == 0
    assert second.wake_reads() == 0


def test_the_probe_interval_cannot_be_configured_below_five_minutes() -> None:
    with pytest.raises(ValidationError):
        Settings(tv_host=TV_HOST, adb_probe_interval_seconds=60)


async def test_with_the_channel_already_open_the_daily_check_just_reads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    await rig.adb.connect()
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 0
    assert rig.adb.unattended_connects == 0
    assert rig.wake_reads() == 1
    assert rig.adb.connected  # era da pessoa: continua aberto
    assert rig.adb.disconnects == 0


async def test_the_daily_check_waits_for_the_owner_command_to_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.setup.owner_busy = lambda: True
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 0
    assert rig.adb.connects == 0
    rig.setup.owner_busy = lambda: False
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    assert rig.probed == 1
    assert rig.wake_reads() == 1


async def test_a_tv_that_comes_back_gets_its_adb_opened_for_the_daily_evaluation_and_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    await tv_is_back(rig.setup)
    await rig.settle()
    assert rig.probed == 1
    # A abertura sem a pessoa não avisa o agendador sozinha: a ligação roda a avaliação do dia
    # enquanto o canal está aberto, e o canal fecha quando ela termina.
    assert rig.wake_reads() == 1
    assert rig.adb.connects == 1
    assert rig.adb.disconnects == 1
    assert not rig.adb.connected


async def test_a_tv_that_comes_back_is_not_connected_when_the_probe_says_unauthorized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.verdicts = [ProbeResult.UNAUTHORIZED]
    await tv_is_back(rig.setup)
    await rig.settle()
    assert rig.probed == 1
    assert rig.adb.connects == 0
    assert rig.wake_reads() == 0


async def test_the_adb_link_survives_a_session_that_fails_to_reopen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)

    async def failing() -> None:
        raise RuntimeError("serviço do controle fora")

    monkeypatch.setattr(rig.setup.manager, "reopen_unattended", failing)
    with pytest.raises(RuntimeError):
        await tv_is_back(rig.setup)
    await rig.settle()
    assert rig.wake_reads() == 1  # o ADB não dependia da sessão
    assert not rig.adb.connected


async def test_the_startup_reconnects_in_the_background_when_only_the_presence_was_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    rig.adb.errors = [AdbIdle("ninguém usando a TV")]
    for step in rig.setup.prepare:
        await step()
    assert "tv.adb" in rig.setup.capabilities  # a partida não esperou pela sonda
    await rig.settle()
    assert rig.probed == 1
    assert rig.wake_reads() == 1
    assert not rig.adb.connected  # e não ficou aberto


async def test_the_startup_does_not_probe_when_the_channel_opened_by_itself(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    for step in rig.setup.prepare:
        await step()
    await rig.settle()
    assert rig.probed == 0
    assert rig.adb.unattended_connects == 0


async def test_the_option_off_keeps_the_old_rule_and_never_probes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path, adb_silent_link=False)
    assert rig.setup.adb_link is None
    assert rig.setup.reconnect_adb is None
    rig.adb.errors = [AdbIdle("ninguém usando a TV")]
    for step in rig.setup.prepare:
        await step()
    await tv_is_back(rig.setup)
    rig.scheduler.note_session_opened(0.1)
    await rig.scheduler.run_pending()
    await rig.settle()
    assert rig.probed == 0
    assert rig.adb.unattended_connects == 0
    assert not rig.adb.connected
    assert rig.wake_reads() == 0


async def test_closing_the_agent_closes_the_silent_link_before_the_adb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    closers = rig.setup.closers
    assert closers[0].__name__ == "close_silent_link"
    assert closers.index(rig.adb.aclose) > 0


async def test_a_pending_reconnect_is_cancelled_on_close_and_nothing_connects_afterwards(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rig = build(monkeypatch, tmp_path)
    gate = asyncio.Event()

    async def slow(
        host: str,
        port: int,
        loader: object,
        timeout: float = 3.0,  # noqa: ASYNC109 - a mesma assinatura da sonda
    ) -> ProbeResult:
        await gate.wait()
        return ProbeResult.AUTHORIZED

    monkeypatch.setattr(tv_module, "silent_adb_probe", slow)
    assert rig.setup.reconnect_adb is not None
    rig.setup.reconnect_adb("tv_back")
    await rig.settle()  # a sonda está esperando a TV
    for closer in rig.setup.closers:
        await closer()
    # Só depois de fechar a sonda "responde": nada pode conectar com o agente já encerrado.
    gate.set()
    await rig.settle()
    assert rig.adb.connects == 0
    assert not rig.adb.connected
    assert rig.wake_reads() == 0
    # E uma nova tentativa depois de fechado não abre nada.
    rig.setup.reconnect_adb("tv_back")
    await rig.settle()
    assert rig.adb.connects == 0


# --- a chave: a que a sonda provou é a que o adb lê --------------------------------------------


def pem_of(key: rsa.RSAPrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


class KeyRig:
    """A pasta `.android` de mentira, a chave que a sonda lê e a conferência da composição."""

    def __init__(self, rig: Rig, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.rig = rig
        self.android = tmp_path / "perfil" / ".android"
        self.android.mkdir(parents=True)
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.write(self.key)
        self.signs = True
        self.result = ProbeResult.AUTHORIZED
        self.unsafe: str | None = None
        monkeypatch.setattr(tv_module, "default_android_dir", lambda: self.android)
        monkeypatch.setattr(tv_module, "load_agent_adbkey", lambda: pem_of(self.key))
        monkeypatch.setattr(tv_module, "silent_adb_probe", self.probe)

        async def unsafe_reason(path: Path) -> str | None:
            return self.unsafe

        monkeypatch.setattr(tv_module, "adbkey_unsafe_reason", unsafe_reason)
        built = tv_module.build_silent_link(
            rig.setup, Settings(tv_host=TV_HOST), TV_HOST, rig.clock
        )
        assert built is not None
        self.link, self.key_check = built

    def write(self, key: rsa.RSAPrivateKey) -> None:
        (self.android / "adbkey").write_bytes(pem_of(key))

    async def probe(
        self,
        host: str,
        port: int,
        loader: Any,
        timeout: float = 3.0,  # noqa: ASYNC109 - a mesma assinatura da sonda
    ) -> ProbeResult:
        if self.signs:
            loader()  # a sonda assina o token com a chave que o carregador entrega
        return self.result


async def test_the_authorized_verdict_carries_the_fingerprint_of_the_key_that_signed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    verdict = await keys.link.clearance()
    assert verdict.result == "authorized"
    assert verdict.key_fingerprint == public_key_fingerprint(pem_of(keys.key))
    assert await keys.key_check(verdict.key_fingerprint) is None


async def test_a_key_replaced_after_the_probe_is_caught_by_the_check_before_the_connect(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    verdict = await keys.link.clearance()
    keys.write(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    assert await keys.key_check(verdict.key_fingerprint) == "key_changed"
    (keys.android / "adbkey").unlink()
    assert await keys.key_check(verdict.key_fingerprint) == "key_changed"


async def test_a_key_the_adb_server_may_not_have_loaded_stops_the_connect(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    verdict = await keys.link.clearance()
    keys.unsafe = "key_stale"
    assert await keys.key_check(verdict.key_fingerprint) == "key_stale"


async def test_an_unsafe_key_is_never_probed_and_the_cause_goes_to_the_diagnostics(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    recorded: list[str] = []
    keys.link.record_with(lambda kind, severity, text: recorded.append(kind))
    keys.unsafe = "vendor_keys"
    verdict = await keys.link.clearance()
    assert verdict.result == "unknown"
    assert verdict.key_fingerprint is None
    assert keys.rig.probed == 0
    assert recorded[0] == "adb.probe.vendor_keys"


async def test_a_tv_that_asks_for_no_signature_has_no_key_in_the_proof(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    keys.signs = False
    verdict = await keys.link.clearance()
    assert verdict.result == "authorized"
    assert verdict.key_fingerprint is None
    assert await keys.key_check(None) is None


async def test_only_an_authorized_probe_carries_a_fingerprint(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    keys = KeyRig(build(monkeypatch, tmp_path), tmp_path, monkeypatch)
    keys.result = ProbeResult.UNAUTHORIZED
    verdict = await keys.link.clearance()
    assert verdict.result == "unauthorized"
    assert verdict.key_fingerprint is None
