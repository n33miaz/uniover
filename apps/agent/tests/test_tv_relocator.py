"""Reencontro da TV: limites do vigia (núcleo) e a ligação com `run` e o `agent.toml`."""

import asyncio
import logging
import tomllib
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent import main as main_module
from uniover_agent.adapters.fakes import FakeClock, FakeSecretStore, FakeTvRemote
from uniover_agent.adapters.local_config import update_config
from uniover_agent.adapters.tv_discovery import DiscoveredTv
from uniover_agent.config import Settings
from uniover_agent.core import TvRelocator
from uniover_agent.main import EXIT_CREDENTIAL_REJECTED, EXIT_TV_MOVED, build_relocator, main, run

from .support import AGENT_ID, TOKEN, FakeApi
from .test_tv_composition import TV_HOST, pair_fake_tv


class Scene:
    """Cenário do vigia: se a TV responde e o que a varredura devolve a cada chamada."""

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


async def test_only_after_three_failures_in_a_row_the_network_is_scanned() -> None:
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


async def test_scans_are_at_most_one_every_ten_minutes() -> None:
    scene = Scene()
    relocator = scene.relocator(failures=1)
    assert await relocator.step() is None
    assert scene.rescans == 1
    for _ in range(5):
        scene.clock.advance(60)
        await relocator.step()
    assert scene.rescans == 1
    scene.clock.advance(600)
    await relocator.step()
    assert scene.rescans == 2


async def test_a_scan_that_blows_up_is_logged_and_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()
    scene.explode = True
    relocator = scene.relocator(failures=1)
    assert await relocator.step() is None
    assert "falha ao procurar a TV" in caplog.text


async def test_run_waits_between_checks_and_returns_the_new_address(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scene = Scene()
    scene.answer = "192.168.0.99"
    relocator = scene.relocator(failures=2, check_seconds=60)
    with caplog.at_level(logging.INFO):
        assert await relocator.run() == "192.168.0.99"
    assert scene.clock.sleeps == [60, 60]
    # O registro diz que mudou, sem endereço nem identificador.
    assert "mudou de endereço" in caplog.text
    assert "192.168.0.99" not in caplog.text


# --- ligação com a configuração e com `run` --------------------------------------------------


def seed(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def read_saved(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def path_exists(path: Path) -> bool:
    return path.exists()


HINT = "11111111-2222-3333-4444-555555555555"


def stub_scan(monkeypatch: pytest.MonkeyPatch, *tvs: DiscoveredTv) -> list[str | None]:
    kinds: list[str | None] = []

    async def find(kind: str | None = None, **_: Any) -> list[DiscoveredTv]:
        kinds.append(kind)
        return list(tvs)

    async def silent(host: str, port: int, wait: float = 1.0) -> bool:
        return False  # nenhum teste conecta em endereço de verdade

    monkeypatch.setattr(main_module, "find_tvs", find)
    monkeypatch.setattr(main_module, "tcp_open", silent)
    return kinds


def test_without_a_hint_or_a_host_there_is_no_relocator() -> None:
    clock = FakeClock()
    assert build_relocator(Settings(tv_host=TV_HOST), clock, lambda: False) is None
    assert build_relocator(Settings(tv_id_hint=HINT), clock, lambda: False) is None


async def test_the_same_tv_at_a_new_address_updates_the_host_and_keeps_the_rest_of_the_file(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    seed(
        isolated_env,
        f'api_url = "https://a.test"\ntv_host = "{TV_HOST}"\ntv_cleanup_keep = ["com.x.y"]\n',
    )
    kinds = stub_scan(
        monkeypatch,
        DiscoveredTv("192.168.0.50", "samsung", ("outra-tv",)),
        DiscoveredTv("192.168.0.77", "samsung", (HINT.upper(), "AA:BB:CC:DD:EE:01")),
    )
    settings = Settings(tv_host=TV_HOST, tv_kind="samsung", tv_id_hint=HINT)
    relocator = build_relocator(settings, FakeClock(), lambda: False)
    assert relocator is not None
    assert await relocator.run() == "192.168.0.77"  # a varredura aconteceu na terceira falha
    saved = read_saved(isolated_env)
    assert saved == {
        "api_url": "https://a.test",
        "tv_host": "192.168.0.77",
        "tv_cleanup_keep": ["com.x.y"],
    }
    assert kinds == ["samsung"]


async def test_the_tv_at_the_same_address_or_not_found_changes_nothing(
    monkeypatch: pytest.MonkeyPatch, isolated_env: Path
) -> None:
    settings = Settings(tv_host=TV_HOST, tv_kind="samsung", tv_id_hint=HINT)
    for tvs in (
        (DiscoveredTv(TV_HOST, "samsung", (HINT,)),),
        (),
        (DiscoveredTv("1.1.1.1", "samsung", ("x",)),),
    ):
        stub_scan(monkeypatch, *tvs)
        relocator = build_relocator(settings, FakeClock(), lambda: False)
        assert relocator is not None
        for _ in range(3):
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

    async def fake_run(settings: Settings, open_store: Any) -> int:
        seen.append(settings.tv_host)
        if len(seen) == 1:
            update_config(isolated_env, {"tv_host": "192.168.0.77"})
            return EXIT_TV_MOVED
        return EXIT_CREDENTIAL_REJECTED

    monkeypatch.setattr(main_module, "run", fake_run)
    assert main(["run"], secrets=FakeSecretStore()) == EXIT_CREDENTIAL_REJECTED
    assert seen == ["192.168.0.10", "192.168.0.77"]
