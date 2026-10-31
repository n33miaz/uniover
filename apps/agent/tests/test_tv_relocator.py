"""Reencontro da TV: limites do vigia (núcleo) e a ligação com `run` e o `agent.toml`."""

import asyncio
import logging
import tomllib
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters import tv_locate
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTvRemote
from uniover_agent.adapters.local_config import update_config
from uniover_agent.adapters.tv_discovery import PortState
from uniover_agent.config import Settings
from uniover_agent.core import TvKnown, TvRelocator
from uniover_agent.main import EXIT_CREDENTIAL_REJECTED, EXIT_TV_MOVED, build_relocator, main, run
from uniover_agent.ports import TvNotPaired

from .support import AGENT_ID, TOKEN, FakeApi
from .test_tv_composition import TV_HOST, pair_fake_tv


class Scene:
    """Cenário do vigia: se a TV responde e o que a procura devolve a cada chamada."""

    def __init__(self, *, hot: bool = False, reachable: bool = False) -> None:
        self.hot = hot
        self.reachable = reachable
        self.rescans = 0
        self.answer: str | None = None
        self.explode = False
        self.clock = FakeClock()

    async def is_reachable(self) -> bool:
        return self.reachable

    async def rescan(self) -> str | None:
        self.rescans += 1
        if self.explode:
            raise RuntimeError("falha qualquer")
        return self.answer

    def relocator(self, **limits: Any) -> TvRelocator:
        return TvRelocator(
            self.clock,
            is_hot=lambda: self.hot,
            reachable=self.is_reachable,
            rescan=self.rescan,
            **limits,
        )


async def test_only_after_three_failures_in_a_row_the_network_is_searched() -> None:
    scene = Scene()
    relocator = scene.relocator()
    assert [await relocator.step(), await relocator.step()] == [None, None]
    assert scene.rescans == 0
    scene.answer = "192.168.0.99"
    assert await relocator.step() == "192.168.0.99"
    assert scene.rescans == 1


async def test_a_tv_that_answers_resets_the_count() -> None:
    scene = Scene()
    relocator = scene.relocator()
    await relocator.step()
    await relocator.step()
    scene.reachable = True
    await relocator.step()
    scene.reachable = False
    await relocator.step()
    await relocator.step()
    assert scene.rescans == 0


async def test_a_hot_session_proves_the_tv_is_there_without_probing() -> None:
    scene = Scene(hot=True)

    async def forbidden() -> bool:
        raise AssertionError("não precisa conferir a porta com a sessão quente")

    relocator = TvRelocator(
        scene.clock, is_hot=lambda: scene.hot, reachable=forbidden, rescan=scene.rescan
    )
    for _ in range(5):
        assert await relocator.step() is None
    assert scene.rescans == 0


async def test_after_the_threshold_every_check_asks_for_the_cheap_search() -> None:
    scene = Scene()
    relocator = scene.relocator(failures=1)
    for _ in range(4):
        scene.clock.advance(60)
        assert await relocator.step() is None
    # O que custa caro (SSDP, varredura) é limitado por quem procura, não por este vigia.
    assert scene.rescans == 4


async def test_the_search_is_announced_once_then_only_summarized(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()
    relocator = scene.relocator(failures=1, summary_seconds=1800)
    with caplog.at_level(logging.INFO):
        for _ in range(10):
            scene.clock.advance(60)
            await relocator.step()
        assert caplog.text.count("procurando na rede") == 1
        scene.clock.advance(1800)
        await relocator.step()
    assert caplog.text.count("segue sem responder") == 1
    scene.reachable = True
    with caplog.at_level(logging.INFO):
        await relocator.step()
    assert "voltou a responder" in caplog.text


async def test_a_search_that_blows_up_is_logged_and_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()
    scene.explode = True
    relocator = scene.relocator(failures=1)
    assert await relocator.step() is None
    assert "falha ao procurar a TV" in caplog.text


async def test_a_check_that_blows_up_counts_as_a_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()

    async def broken() -> bool:
        raise RuntimeError("falha qualquer")

    relocator = TvRelocator(
        scene.clock, is_hot=lambda: False, reachable=broken, rescan=scene.rescan, failures=1
    )
    assert await relocator.step() is None
    assert scene.rescans == 1
    assert "falha ao conferir a TV" in caplog.text


async def test_run_waits_between_checks_and_returns_the_new_address(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()
    answers = iter([None, "192.168.0.99"])

    async def rescan() -> str | None:
        return next(answers)

    relocator = TvRelocator(
        scene.clock,
        is_hot=lambda: False,
        reachable=scene.is_reachable,
        rescan=rescan,
        failures=1,
        check_seconds=60,
    )
    with caplog.at_level(logging.INFO):
        assert await relocator.run() == "192.168.0.99"
    assert scene.clock.sleeps == [60, 60]
    # O registro diz que mudou, sem endereço nem identificador.
    assert "mudou de endereço" in caplog.text
    assert "192.168.0.99" not in caplog.text


# --- a rede de mentira: o caso real (IP velho de outro aparelho, TV em outro IP) ------------------

OLD_HOST = "192.168.0.11"  # agora é de um celular: responde ping, nenhuma porta aberta
NEW_HOST = "192.168.0.14"
DUID = "12345678-aaaa-bbbb-cccc-1234567890ab"
MAC = "74:6D:FA:5D:52:08"
TV_INFO = {"device": {"type": "Samsung SmartTV", "duid": f"uuid:{DUID}", "wifiMac": MAC.lower()}}


class Lan:
    """Rede doméstica falsa: portas, respostas do REST, tabela ARP e respostas ao SSDP."""

    def __init__(self) -> None:
        self.open: dict[tuple[str, int], bool] = {(NEW_HOST, 8001): True}
        self.rest: dict[str, dict[str, Any]] = {NEW_HOST: TV_INFO}
        self.arp: dict[str, list[str]] = {}
        self.ssdp_hosts: list[str] = []
        self.contacted: list[str] = []
        self.ssdp_calls = 0
        self.arp_calls = 0

    async def tcp_open(self, host: str, port: int, wait: float = 1.0) -> bool:
        self.contacted.append(host)
        return self.open.get((host, port), False)

    async def http_json(self, url: str) -> dict[str, Any] | None:
        host = url.split("//")[1].split(":", maxsplit=1)[0]
        self.contacted.append(host)
        return self.rest.get(host)

    async def arp_table(self) -> dict[str, list[str]]:
        self.arp_calls += 1
        return self.arp

    async def ssdp_search(self, kind: str, interface: str, wait: float = 0.0) -> list[str]:
        self.ssdp_calls += 1
        return self.ssdp_hosts

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tv_locate, "tcp_open", self.tcp_open)
        monkeypatch.setattr(tv_locate, "http_json", self.http_json)
        monkeypatch.setattr(tv_locate, "arp_table", self.arp_table)
        monkeypatch.setattr(tv_locate, "ssdp_search", self.ssdp_search)
        # A placa com rota padrão é a do cabo sem rede (link-local); a TV está no Wi-Fi.
        monkeypatch.setattr(tv_locate, "local_ipv4", lambda: "169.254.190.176")
        monkeypatch.setattr(tv_locate, "local_address_for", lambda host: "192.168.0.12")


def read_saved(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def path_exists(path: Path) -> bool:
    return path.exists()


def settings_for_old_host(**extra: Any) -> Settings:
    return Settings(tv_host=OLD_HOST, tv_kind="samsung", tv_id_hint=DUID, **extra)


async def steps_until_moved(relocator: TvRelocator, limit: int = 3) -> str | None:
    moved: str | None = None
    for _ in range(limit):
        moved = await relocator.step()
    return moved


@pytest.mark.parametrize("how", ["arp", "ssdp", "sweep"])
async def test_the_tv_moved_to_another_address_is_found_and_the_new_one_is_saved(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path, how: str
) -> None:
    """Reproduz o caso real: o IP velho virou de um celular e a TV foi para outro endereço do /24.

    A rota padrão desta máquina pode ser a de uma placa sem rede (169.254.x): a procura tem de
    ser no /24 da TV, e a TV é confirmada pelo `duid` no REST (não basta ser "uma Samsung").
    """
    lan = Lan()
    if how == "arp":
        lan.arp = {MAC: [NEW_HOST]}
    elif how == "ssdp":
        lan.ssdp_hosts = ["192.168.0.30", NEW_HOST]
        lan.rest["192.168.0.30"] = {"device": {"type": "Samsung SmartTV", "duid": "uuid:outra"}}
    lan.install(monkeypatch)
    update_config(isolated_env, {"tv_host": OLD_HOST, "tv_cleanup_keep": ["com.x.y"]})
    relocator = build_relocator(settings_for_old_host(tv_mac=MAC), FakeClock(), lambda: False)
    assert relocator is not None
    assert await steps_until_moved(relocator) == NEW_HOST
    saved = read_saved(isolated_env)
    assert saved["tv_host"] == NEW_HOST
    assert saved["tv_mac"] == MAC
    assert saved["tv_id_hint"] == DUID
    assert saved["tv_cleanup_keep"] == ["com.x.y"]  # o resto do arquivo é preservado
    # Nada foi perguntado fora do /24 da TV (a rota padrão apontava para 169.254.x).
    assert all(host.startswith("192.168.0.") for host in lan.contacted)
    if how == "arp":
        assert lan.ssdp_calls == 0  # o ARP bastou: nada de multicast nem de varredura


async def test_the_old_address_answering_as_another_device_is_not_the_tv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lan = Lan()
    lan.open[(OLD_HOST, 8001)] = True
    lan.rest[OLD_HOST] = {"device": {"type": "Samsung SmartTV", "duid": "uuid:de-outra-tv"}}
    lan.install(monkeypatch)
    relocator = build_relocator(settings_for_old_host(), FakeClock(), lambda: False)
    assert relocator is not None
    # Responder na porta e até ser Samsung não basta: o `duid` não é o da nossa TV.
    assert await steps_until_moved(relocator) == NEW_HOST


async def test_the_tv_still_at_its_address_is_reachable_and_nothing_is_searched(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open[(OLD_HOST, 8001)] = True
    lan.rest[OLD_HOST] = TV_INFO
    lan.install(monkeypatch)
    relocator = build_relocator(settings_for_old_host(), FakeClock(), lambda: False)
    assert relocator is not None
    for _ in range(5):
        assert await relocator.step() is None
    assert lan.ssdp_calls == 0  # nenhuma procura; o ARP só é lido para aprender o MAC
    assert not path_exists(isolated_env)


async def test_a_tv_asleep_at_the_same_address_does_not_trigger_a_sweep(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open.clear()  # standby: nenhuma porta abre, mas o ARP ainda a vê onde sempre esteve
    lan.arp = {MAC: [OLD_HOST]}
    lan.install(monkeypatch)
    relocator = build_relocator(settings_for_old_host(tv_mac=MAC), FakeClock(), lambda: False)
    assert relocator is not None
    for _ in range(6):
        assert await relocator.step() is None
    assert lan.ssdp_calls == 0
    assert not path_exists(isolated_env)


async def test_the_relocator_learns_the_mac_from_the_shared_record(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    """A instalação antiga só tem o `duid`; o MAC aprendido na conexão passa a valer na hora."""
    lan = Lan()
    lan.arp = {MAC: [NEW_HOST]}
    lan.install(monkeypatch)
    known = TvKnown(hint="outro-id-antigo", mac=None)
    relocator = build_relocator(settings_for_old_host(), FakeClock(), lambda: False, known)
    assert relocator is not None
    known.mac = MAC  # aprendido na primeira conexão (o REST o entregou)
    assert await steps_until_moved(relocator) == NEW_HOST


def test_without_a_host_there_is_no_relocator() -> None:
    assert build_relocator(Settings(tv_id_hint=DUID), FakeClock(), lambda: False) is None


async def test_a_tv_that_cannot_be_identified_is_never_guessed(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.install(monkeypatch)
    relocator = build_relocator(
        Settings(tv_host=OLD_HOST, tv_kind="samsung"), FakeClock(), lambda: False
    )
    assert relocator is not None
    # Sem `duid` nem MAC guardados, qualquer Samsung do /24 seria um palpite: não procura.
    assert await steps_until_moved(relocator, limit=5) is None
    assert not path_exists(isolated_env)


async def test_android_without_saved_identity_uses_the_paired_session_and_saves_the_new_host(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path, caplog: pytest.LogCaptureFixture
) -> None:
    lan = Lan()
    lan.open = {(NEW_HOST, 6466): True, ("192.168.0.20", 6466): True}
    lan.arp = {MAC: [NEW_HOST]}
    lan.install(monkeypatch)
    monkeypatch.setattr(
        tv_locate,
        "subnet_hosts",
        lambda base, exclude=None: [OLD_HOST, NEW_HOST, "192.168.0.20"],
    )

    async def silent(host: str, port: int, wait: float) -> PortState:
        assert (host, port) == (OLD_HOST, 6466)
        return PortState.SILENT

    monkeypatch.setattr(main_module, "tcp_probe", silent)
    sessions: list[tuple[str, str]] = []

    class FakeAuthenticatedRemote:
        def __init__(self, host: str, client_name: str, cert_dir: Path) -> None:
            self.host = host

        async def connect(self) -> None:
            sessions.append((self.host, "open"))
            if self.host != NEW_HOST:
                raise TvNotPaired("outro aparelho")

        async def disconnect(self) -> None:
            sessions.append((self.host, "close"))

    monkeypatch.setattr(main_module, "AndroidTvRemoteV2", FakeAuthenticatedRemote)
    update_config(isolated_env, {"tv_host": OLD_HOST, "tv_text_by_keys": True})
    relocator = build_relocator(
        Settings(tv_host=OLD_HOST, tv_kind="android"), FakeClock(), lambda: False
    )
    assert relocator is not None
    with caplog.at_level(logging.INFO):
        assert await steps_until_moved(relocator) == NEW_HOST
    saved = read_saved(isolated_env)
    assert saved["tv_host"] == NEW_HOST
    assert saved["tv_mac"] == MAC
    assert saved["tv_text_by_keys"] is True
    assert sessions.count((NEW_HOST, "open")) == 1
    assert sessions.count((NEW_HOST, "close")) == 1
    assert sessions.count(("192.168.0.20", "open")) == 1
    assert sessions.count(("192.168.0.20", "close")) == 1
    assert "a TV mudou de endereço na rede" in caplog.text
    assert NEW_HOST not in caplog.text
    assert MAC not in caplog.text


async def test_android_does_not_learn_arp_from_an_unverified_open_port(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    lan = Lan()
    lan.open = {(OLD_HOST, 6466): True}
    lan.arp = {MAC: [OLD_HOST]}
    lan.install(monkeypatch)

    async def open_port(host: str, port: int, wait: float) -> PortState:
        return PortState.OPEN

    monkeypatch.setattr(main_module, "tcp_probe", open_port)
    relocator = build_relocator(
        Settings(tv_host=OLD_HOST, tv_kind="android"), FakeClock(), lambda: False
    )
    assert relocator is not None
    assert await relocator.step() is None
    assert not path_exists(isolated_env)


async def test_run_returns_tv_moved_so_main_can_restart_with_the_new_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = FakeTvRemote()
    pair_fake_tv(monkeypatch, remote)

    class Moved:
        async def run(self) -> str:
            await asyncio.sleep(0.3)
            return "192.168.0.77"

    monkeypatch.setattr(main_module, "build_relocator", lambda *a, **k: Moved())

    async def script(connection: ServerConnection) -> None:
        await asyncio.sleep(5)

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        assert await run(settings, lambda: store) == EXIT_TV_MOVED
    # Nada ficou aberto: nem a sessão com a TV.
    assert not remote.connected


def test_main_restarts_run_with_fresh_settings_after_a_move(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    update_config(isolated_env, {"tv_host": "192.168.0.10"})
    seen: list[str | None] = []

    async def fake_run(settings: Settings, open_store: Any, kit: Any = None) -> int:
        seen.append(settings.tv_host)
        if len(seen) == 1:
            update_config(isolated_env, {"tv_host": "192.168.0.77"})
            return EXIT_TV_MOVED
        return EXIT_CREDENTIAL_REJECTED

    monkeypatch.setattr(main_module, "run", fake_run)
    assert main(["run"], secrets=FakeSecretStore()) == EXIT_CREDENTIAL_REJECTED
    assert seen == ["192.168.0.10", "192.168.0.77"]


async def test_the_mac_the_arp_shows_for_a_confirmed_tv_is_saved_once(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    """TV no cabo: o ARP mostra o MAC da placa de rede, que não é o `wifiMac` do REST."""
    lan = Lan()
    lan.open[(OLD_HOST, 8001)] = True
    lan.rest[OLD_HOST] = TV_INFO
    lan.arp = {"AA:00:00:00:00:77": [OLD_HOST]}
    lan.install(monkeypatch)
    update_config(isolated_env, {"tv_host": OLD_HOST})
    clock = FakeClock()
    relocator = build_relocator(settings_for_old_host(tv_mac=MAC), clock, lambda: False)
    assert relocator is not None
    await relocator.step()
    assert read_saved(isolated_env)["tv_mac"] == "AA:00:00:00:00:77"
    calls = lan.arp_calls
    for _ in range(5):  # já aprendido: não volta a olhar a tabela
        clock.advance(60)
        await relocator.step()
    assert lan.arp_calls == calls


async def test_the_watch_does_nothing_while_focus_is_active() -> None:
    scene = Scene()
    scene.answer = "192.168.0.99"
    relocator = scene.relocator(is_paused=lambda: True)

    assert [await relocator.step() for _ in range(5)] == [None] * 5
    assert scene.rescans == 0
