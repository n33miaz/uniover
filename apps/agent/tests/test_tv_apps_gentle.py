"""Lista de apps e ícones sob demanda: cache de um dia, nada de consulta a cada reconexão."""

import asyncio
from pathlib import Path

from uniover_agent.adapters.tv_samsung import SAMSUNG_ICON_MAX_FAILURES, SamsungTvDriver
from uniover_agent.core import AppsAnnouncer
from uniover_agent.ports import AdbTimeout

from .test_tv_apps import Env, hot, settle
from .test_tv_icons import Pub, Rig, entries
from .test_tv_samsung import FakeSamsungClient, factory, power_on


class Counting(Env):
    """Ambiente de apps que conta quantas vezes a TV foi perguntada pela lista."""

    def __init__(self) -> None:
        super().__init__()
        self.lists = 0
        original = self.adb.list_apps

        async def counted() -> list:  # type: ignore[type-arg]
            self.lists += 1
            return await original()

        self.adb.list_apps = counted  # type: ignore[method-assign]


async def announce(env: Counting, announcer: AppsAnnouncer) -> None:
    await announcer.after_hello()
    announcer.on_state(hot())
    await settle()


async def test_reconnections_during_the_day_never_ask_the_tv_for_the_list_again() -> None:
    env = Counting()
    announcer = AppsAnnouncer(env.apps, lambda: True, monotonic=env.clock.monotonic)
    task = asyncio.create_task(announcer.run())
    await announce(env, announcer)
    assert env.lists == 1
    for _ in range(6):  # a conexão com a API cai e volta de poucos em poucos minutos
        env.clock.advance(300)
        await announce(env, announcer)
    assert env.lists == 1
    assert len(env.apps_messages()) == 7  # a lista guardada vai a cada nova conexão
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_after_a_day_the_list_is_asked_again_when_the_session_is_hot() -> None:
    env = Counting()
    announcer = AppsAnnouncer(env.apps, lambda: True, monotonic=env.clock.monotonic)
    task = asyncio.create_task(announcer.run())
    await announce(env, announcer)
    env.clock.advance(86399)
    await announce(env, announcer)
    assert env.lists == 1
    env.clock.advance(2)
    await announce(env, announcer)
    assert env.lists == 2
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_stale_list_with_the_tv_asleep_is_resent_without_waking_it() -> None:
    env = Counting()
    state = {"hot": True}
    announcer = AppsAnnouncer(env.apps, lambda: state["hot"], monotonic=env.clock.monotonic)
    task = asyncio.create_task(announcer.run())
    await announce(env, announcer)
    state["hot"] = False
    env.clock.advance(3 * 86400)
    await announce(env, announcer)
    assert env.lists == 1
    assert len(env.apps_messages()) == 2
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_failed_daily_refresh_is_not_retried_for_an_hour() -> None:
    env = Counting()
    announcer = AppsAnnouncer(env.apps, lambda: True, monotonic=env.clock.monotonic)
    task = asyncio.create_task(announcer.run())
    await announce(env, announcer)
    env.clock.advance(86401)
    env.adb.errors = [AdbTimeout("x")]
    await announce(env, announcer)
    assert env.lists == 2  # tentou e falhou
    for _ in range(5):
        env.clock.advance(300)
        await announce(env, announcer)
    assert env.lists == 2  # nada de insistir a cada reconexão
    env.clock.advance(3600)
    await announce(env, announcer)
    assert env.lists == 3
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_without_a_cached_list_a_failed_first_read_is_retried_in_minutes() -> None:
    env = Counting()
    announcer = AppsAnnouncer(env.apps, lambda: True, monotonic=env.clock.monotonic)
    task = asyncio.create_task(announcer.run())
    env.adb.errors = [AdbTimeout("x"), AdbTimeout("x"), AdbTimeout("x"), AdbTimeout("x")]
    await announce(env, announcer)
    assert env.lists == 1
    # Sem lista o app fica vazio: espera de 2, depois 5, depois 15 minutos (o teto), não 1 hora.
    for wait in (120, 300, 900, 900):
        env.clock.advance(wait - 1)
        await announce(env, announcer)
        before = env.lists
        env.clock.advance(1)
        await announce(env, announcer)
        assert env.lists == before + 1, wait
    # A próxima leitura dá certo: a lista chega e a espera volta a zero.
    env.clock.advance(900)
    await announce(env, announcer)
    assert env.apps_messages()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


# --- ícones: as versões dos apps não são perguntadas à TV a cada reenvio -------------------------


class CountingRig(Pub):
    def __init__(self, rig: Rig, **kwargs: object) -> None:
        super().__init__(rig, **kwargs)  # type: ignore[arg-type]
        self.version_reads = 0
        original = rig.source.package_versions

        async def counted() -> dict[str, int]:
            self.version_reads += 1
            return await original()

        rig.source.package_versions = counted  # type: ignore[method-assign]
        self.publisher._monotonic = self.clock.monotonic


async def test_a_resent_list_reuses_the_versions_read_from_the_tv(tmp_path: Path) -> None:
    pub = CountingRig(Rig(tmp_path))
    pub.publisher.request(entries())
    await pub.settle()
    assert pub.version_reads == 1
    pub.publisher.request(entries(), refresh_versions=False)  # reconexão com a API
    await pub.settle()
    assert pub.version_reads == 1


async def test_a_list_asked_by_the_app_reads_the_versions_again(tmp_path: Path) -> None:
    pub = CountingRig(Rig(tmp_path))
    pub.publisher.request(entries())
    await pub.settle()
    pub.publisher.request(entries())  # o app abriu a tela de apps
    await pub.settle()
    assert pub.version_reads == 2


async def test_the_versions_expire_after_a_day(tmp_path: Path) -> None:
    pub = CountingRig(Rig(tmp_path))
    pub.publisher.request(entries())
    await pub.settle()
    pub.clock.advance(86401)
    pub.publisher.request(entries(), refresh_versions=False)
    await pub.settle()
    assert pub.version_reads == 2


# --- Samsung: ícones só quando a lista é pedida, e sem insistir numa TV muda ---------------------


class IconCounting(FakeSamsungClient):
    def __init__(self) -> None:
        super().__init__()
        self.icon_calls = 0
        self.apps = [
            {"appId": str(number), "name": f"App {number}", "icon": f"/icone/{number}.png"}
            for number in range(10)
        ]

    def app_icon(self, icon_path: str) -> str | None:
        self.icon_calls += 1
        return self.icons.get(icon_path)


async def test_a_samsung_that_never_answers_the_icons_is_asked_only_a_few_times() -> None:
    client = IconCounting()
    driver = SamsungTvDriver(
        "192.168.0.11", "t", "U", factory=factory(client), fetch_power=power_on
    )
    await driver.connect()
    listed = await driver.app_list()
    assert listed is not None
    assert len(listed) == 10  # a lista sai completa, só sem imagens
    assert client.icon_calls == SAMSUNG_ICON_MAX_FAILURES


async def test_a_samsung_that_answers_every_icon_gets_them_all() -> None:
    client = IconCounting()
    client.icons = {f"/icone/{number}.png": "aWNvbmU=" for number in range(10)}
    driver = SamsungTvDriver(
        "192.168.0.11", "t", "U", factory=factory(client), fetch_power=power_on
    )
    await driver.connect()
    listed = await driver.app_list()
    assert listed is not None
    assert client.icon_calls == 10
    assert all(item.get("imageBase64") for item in listed)


async def test_connecting_the_samsung_session_never_lists_apps() -> None:
    client = IconCounting()
    driver = SamsungTvDriver(
        "192.168.0.11", "t", "U", factory=factory(client), fetch_power=power_on
    )
    await driver.connect()
    await driver.disconnect()
    assert client.icon_calls == 0
