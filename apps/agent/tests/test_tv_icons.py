"""Ícones dos apps: resolução (cache por versão, APK, candidatos) e publicação em `tv.apps.v2`."""

import asyncio
import base64
import logging
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb, FakeTvRemote
from uniover_agent.core import (
    AppEntry,
    AppIconPublisher,
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    IconResolver,
    ResultStatus,
    TvApps,
    TvSessionManager,
    TvState,
    tv_apps_refresh_handler,
)
from uniover_agent.core.envelopes import serialized_size
from uniover_agent.core.tv.icon_badging import MAX_ICON_BYTES
from uniover_agent.core.tv.icons import MAX_ENVELOPE_BYTES, validate_icon
from uniover_agent.ports import (
    AdbTimeout,
    AdbUnreachable,
    AppIcon,
    CachedIcon,
    IconToolError,
    LaunchableApp,
    TransportError,
)

from .support import AGENT_ID
from .support_icons import (
    BADGING_BANNER_ONLY,
    BADGING_DENSITIES,
    FakeApkSource,
    FakeInspector,
    FolderScratch,
    MemoryIconCache,
    png_bytes,
    webp_bytes,
)

CINEVS = "com.cnvs.apptv"
PLAYER = "com.exemplo.player"
BASE = "/data/app/~~x==/com.cnvs.apptv-y==/base.apk"
PLAYER_BASE = "/data/app/~~p==/com.exemplo.player-q==/base.apk"
PLAYER_SPLIT = "/data/app/~~p==/com.exemplo.player-q==/split_config.xxhdpi.apk"

BANNER = png_bytes(32, 18)
ICON_BIG = png_bytes(8, 8)


class Rig:
    """Um app CineVS (só banner PNG) e um Player (PNG por densidade), com dublês das portas."""

    def __init__(self, tmp_path: Path) -> None:
        self.source = FakeApkSource()
        self.inspector = FakeInspector()
        self.cache = MemoryIconCache()
        self.scratch = FolderScratch(tmp_path)
        self.resolver = IconResolver(self.source, self.inspector, self.cache, self.scratch)
        self.source.versions = {CINEVS: 50, PLAYER: 7}
        self.source.paths = {CINEVS: [BASE], PLAYER: [PLAYER_BASE]}
        self.source.apks = {BASE: b"apk-cinevs", PLAYER_BASE: b"apk-player"}
        self.inspector.badging = {
            b"apk-cinevs": BADGING_BANNER_ONLY,
            b"apk-player": BADGING_DENSITIES,
        }
        self.inspector.members = {
            (b"apk-cinevs", "res/Ec.png"): BANNER,
            (b"apk-player", "res/mipmap-xxxhdpi-v4/ic_launcher.png"): ICON_BIG,
        }


@pytest.fixture
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


# --- validação do conteúdo ----------------------------------------------------------------------


def test_validate_icon_accepts_png_and_webp_within_the_limit() -> None:
    assert validate_icon(png_bytes()) == AppIcon("image/png", png_bytes())
    assert validate_icon(webp_bytes()) == AppIcon("image/webp", webp_bytes())


def test_validate_icon_refuses_empty_unknown_and_too_big() -> None:
    assert validate_icon(None) is None
    assert validate_icon(b"") is None
    assert validate_icon(b"<svg/>") is None
    big = png_bytes(pad_to=MAX_ICON_BYTES + 1)
    assert len(big) == MAX_ICON_BYTES + 1
    assert validate_icon(big) is None
    exact = png_bytes(pad_to=MAX_ICON_BYTES)
    assert len(exact) == MAX_ICON_BYTES
    assert validate_icon(exact) is not None


# --- resolução ----------------------------------------------------------------------------------


async def test_the_banner_is_used_when_every_icon_is_xml_and_the_apk_copy_is_deleted(
    rig: Rig,
) -> None:
    icon = await rig.resolver.resolve(CINEVS, 50)
    assert icon == AppIcon("image/png", BANNER)
    assert rig.source.pulled == [BASE]
    assert rig.cache.entries == {(CINEVS, 50): icon}
    # Só o arquivo de imagem foi lido de dentro do APK; a cópia temporária não sobra.
    assert rig.inspector.read == ["res/Ec.png"]
    assert rig.scratch.leftovers() == []


async def test_the_largest_density_wins_and_a_too_big_one_falls_to_the_next_smaller(
    rig: Rig,
) -> None:
    huge = png_bytes(pad_to=MAX_ICON_BYTES + 100)
    rig.inspector.members[(b"apk-player", "res/mipmap-xxxhdpi-v4/ic_launcher.png")] = huge
    # O `read_member` do dublê já recusa o que passa do limite, como o adaptador real.
    medium = png_bytes(6, 6)
    rig.inspector.members[(b"apk-player", "res/mipmap-xxhdpi-v4/ic_launcher.png")] = medium
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", medium)
    assert rig.inspector.read[:2] == [
        "res/mipmap-xxxhdpi-v4/ic_launcher.png",
        "res/mipmap-xxhdpi-v4/ic_launcher.png",
    ]


async def test_a_cache_hit_does_not_touch_the_tv(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/png", BANNER)
    cached = rig.resolver.cached(CINEVS, 50)
    assert cached == CachedIcon(AppIcon("image/png", BANNER))
    assert rig.source.pulled == []


async def test_a_new_version_misses_the_cache_and_replaces_the_old_entry(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 49)] = AppIcon("image/png", png_bytes(2, 2))
    assert rig.resolver.cached(CINEVS, 50) is None
    await rig.resolver.resolve(CINEVS, 50)
    assert list(rig.cache.entries) == [(CINEVS, 50)]


async def test_an_app_without_usable_image_is_cached_as_no_icon(rig: Rig) -> None:
    rig.inspector.members.clear()
    assert await rig.resolver.resolve(CINEVS, 50) is None
    assert rig.resolver.cached(CINEVS, 50) == CachedIcon(None)
    assert rig.scratch.leftovers() == []


async def test_a_tampered_cache_entry_counts_as_never_downloaded(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/png", b"nao e png")
    assert rig.resolver.cached(CINEVS, 50) is None


async def test_the_version_comes_from_the_badging_when_the_listing_has_none(rig: Rig) -> None:
    await rig.resolver.resolve(CINEVS, None)
    assert list(rig.cache.entries) == [(CINEVS, 50)]


async def test_without_any_version_nothing_is_cached(rig: Rig) -> None:
    rig.inspector.badging[b"apk-cinevs"] = "package: name='com.cnvs.apptv'\n" + (
        "application: label='A' icon='res/x.xml' banner='res/Ec.png'\n"
    )
    assert await rig.resolver.resolve(CINEVS, None) == AppIcon("image/png", BANNER)
    assert rig.cache.entries == {}


async def test_a_package_without_apk_path_gives_none_and_caches_nothing(rig: Rig) -> None:
    rig.source.paths[CINEVS] = []
    assert await rig.resolver.resolve(CINEVS, 50) is None
    assert rig.cache.entries == {}
    assert rig.source.pulled == []


async def test_a_failed_pull_raises_and_caches_nothing(rig: Rig) -> None:
    del rig.source.apks[BASE]
    with pytest.raises(Exception, match="não entregou"):
        await rig.resolver.resolve(CINEVS, 50)
    assert rig.cache.entries == {}
    assert rig.scratch.leftovers() == []


async def test_a_broken_aapt_raises_and_still_deletes_the_copy(rig: Rig) -> None:
    rig.inspector.badging_error = IconToolError("o aapt2 não conseguiu ler o APK")
    with pytest.raises(IconToolError):
        await rig.resolver.resolve(CINEVS, 50)
    assert rig.cache.entries == {}
    assert rig.scratch.leftovers() == []


async def test_density_split_is_searched_only_when_the_base_has_no_usable_image(rig: Rig) -> None:
    rig.source.paths[PLAYER] = [PLAYER_BASE, "/data/app/~~p==/x/split_config.pt.apk", PLAYER_SPLIT]
    rig.source.apks[PLAYER_SPLIT] = b"split-xxhdpi"
    del rig.inspector.members[(b"apk-player", "res/mipmap-xxxhdpi-v4/ic_launcher.png")]
    in_split = png_bytes(5, 5)
    rig.inspector.members[(b"split-xxhdpi", "res/mipmap-xxhdpi-v4/ic_launcher.png")] = in_split
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", in_split)
    # Só o APK de densidade foi copiado além do base; o de idioma (`pt`) nunca.
    assert rig.source.pulled == [PLAYER_BASE, PLAYER_SPLIT]
    assert rig.scratch.leftovers() == []


async def test_density_split_is_not_pulled_when_the_base_already_has_the_icon(rig: Rig) -> None:
    rig.source.paths[PLAYER] = [PLAYER_BASE, PLAYER_SPLIT]
    await rig.resolver.resolve(PLAYER, 7)
    assert rig.source.pulled == [PLAYER_BASE]


# --- publicação ---------------------------------------------------------------------------------


def entries() -> list[AppEntry]:
    return [AppEntry(CINEVS, "CineVS", True), AppEntry(PLAYER, "Player")]


class Pub:
    """Publicador ligado a um transporte falso e a um relógio que não espera."""

    def __init__(self, rig: Rig, *, hot: bool = True) -> None:
        self.rig = rig
        self.hot = hot
        self.transport = FakeTransport()
        self.clock = FakeClock()
        envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock)
        self.publisher = AppIconPublisher(
            rig.resolver,
            rig.source,
            self.transport,
            envelopes,
            lambda: self.hot,
            self.clock.sleep,
            pause=0.25,
        )

    async def settle(self) -> None:
        """Roda a tarefa de fundo até ela voltar a esperar (nada pendente)."""
        task = asyncio.create_task(self.publisher.run())
        try:
            for _ in range(2000):
                await asyncio.sleep(0)
            assert not self.publisher._trigger.is_set()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def v2(self) -> list[dict[str, Any]]:
        return [m for m in self.transport.sent if m["type"] == "tv.apps.v2"]


def icon_of(app: dict[str, Any]) -> bytes | None:
    icon = app.get("icon")
    return base64.b64decode(icon["data"]) if icon else None


async def test_icons_are_published_one_message_per_pulled_app_and_the_list_is_always_complete(
    rig: Rig,
) -> None:
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    first, second = pub.v2()
    for message in (first, second):
        assert message["target"] == "api"
        assert message["correlationId"] is None
        assert [a["package"] for a in message["body"]["apps"]] == [CINEVS, PLAYER]
    assert [icon_of(a) for a in first["body"]["apps"]] == [BANNER, None]
    assert [icon_of(a) for a in second["body"]["apps"]] == [None, ICON_BIG]
    assert first["body"]["apps"][0]["icon"]["mime"] == "image/png"
    # Um respiro antes de cada APK (nada de rajada contra a TV, que tem pouca memória).
    assert pub.clock.sleeps == [0.25, 0.25]
    assert rig.scratch.leftovers() == []


async def test_cached_icons_go_out_first_in_a_single_message_without_pulling(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/png", BANNER)
    rig.cache.entries[(PLAYER, 7)] = AppIcon("image/png", ICON_BIG)
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    (message,) = pub.v2()
    assert [icon_of(a) for a in message["body"]["apps"]] == [BANNER, ICON_BIG]
    assert rig.source.pulled == []
    assert pub.clock.sleeps == []


async def test_a_second_request_resends_from_the_cache_and_never_downloads_again(
    rig: Rig,
) -> None:
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    pulled = list(rig.source.pulled)
    pub.transport.sent.clear()
    pub.publisher.request(entries())  # outro refresh (ou outra conexão com a API)
    await pub.settle()
    (message,) = pub.v2()
    assert [icon_of(a) for a in message["body"]["apps"]] == [BANNER, ICON_BIG]
    assert rig.source.pulled == pulled


async def test_an_app_with_no_usable_image_stays_in_the_list_without_the_icon_field(
    rig: Rig,
) -> None:
    rig.inspector.members.pop((b"apk-cinevs", "res/Ec.png"))
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    (message,) = pub.v2()
    first_app = message["body"]["apps"][0]
    assert first_app == {"package": CINEVS, "label": "CineVS"}
    # Marcado como "sem ícone" no cache: a próxima lista não baixa o APK de novo.
    assert rig.cache.entries[(CINEVS, 50)] is None


async def test_every_message_stays_under_the_transport_limit(rig: Rig) -> None:
    # Dez apps com ícones perto do teto de 32 KB: não cabem todos numa mensagem de 64 KB.
    apps: list[AppEntry] = []
    for index in range(10):
        package = f"com.exemplo.app{index}"
        apps.append(AppEntry(package, f"App {index}"))
        rig.cache.entries[(package, 1)] = AppIcon(
            "image/png", png_bytes(pad_to=MAX_ICON_BYTES - index)
        )
        rig.source.versions[package] = 1
    pub = Pub(rig)
    pub.publisher.request(apps)
    await pub.settle()
    messages = pub.v2()
    assert len(messages) > 1
    assert all(serialized_size(m) <= MAX_ENVELOPE_BYTES for m in messages)
    assert MAX_ENVELOPE_BYTES < 64 * 1024
    delivered = {a["package"] for m in messages for a in m["body"]["apps"] if "icon" in a}
    assert delivered == {a.package for a in apps}
    # Cada ícone sai uma única vez.
    sent_icons = [a["package"] for m in messages for a in m["body"]["apps"] if "icon" in a]
    assert len(sent_icons) == len(set(sent_icons)) == 10


async def test_nothing_is_pulled_while_the_session_is_not_hot_and_it_resumes_when_hot(
    rig: Rig,
) -> None:
    pub = Pub(rig, hot=False)
    pub.publisher.request(entries())
    await pub.settle()
    assert rig.source.pulled == []
    assert pub.v2() == []
    pub.hot = True
    pub.publisher.on_state(TvState("on", None, None, "hot"))
    await pub.settle()
    assert len(pub.v2()) == 2


async def test_a_state_change_does_not_trigger_work_when_nothing_is_unfinished(rig: Rig) -> None:
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    pub.transport.sent.clear()
    pub.publisher.on_state(TvState("on", None, None, "hot"))
    await pub.settle()
    assert pub.v2() == []


async def test_a_tv_that_stops_answering_ends_the_pass_and_resumes_later(rig: Rig) -> None:
    rig.source.errors[CINEVS] = AdbUnreachable("a conexão ADB com a TV caiu")
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    assert pub.v2() == []
    assert rig.source.pulled == []  # parou no primeiro: o segundo nem foi tentado
    del rig.source.errors[CINEVS]
    pub.publisher.on_state(TvState("on", None, None, "hot"))
    await pub.settle()
    assert len(pub.v2()) == 2


async def test_a_failing_app_does_not_block_the_others(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.source.errors[CINEVS] = AdbTimeout("a TV demorou demais para responder ao ADB")
    pub = Pub(rig)
    with caplog.at_level(logging.DEBUG):
        pub.publisher.request(entries())
        await pub.settle()
    (message,) = pub.v2()
    assert [icon_of(a) for a in message["body"]["apps"]] == [None, ICON_BIG]
    assert CINEVS in caplog.text
    # O conteúdo da imagem nunca vai ao registro.
    assert base64.b64encode(ICON_BIG).decode() not in caplog.text


async def test_a_version_listing_failure_leaves_icons_for_later(rig: Rig) -> None:
    rig.source.version_error = AdbUnreachable("x")
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    assert pub.v2() == []
    rig.source.version_error = None
    pub.publisher.on_state(TvState("on", None, None, "hot"))
    await pub.settle()
    assert len(pub.v2()) == 2


async def test_a_broken_aapt_for_one_app_is_logged_and_the_next_app_is_tried(rig: Rig) -> None:
    rig.inspector.badging_error = IconToolError("o aapt2 não conseguiu ler o APK")
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    assert pub.v2() == []
    assert rig.source.pulled == [BASE, PLAYER_BASE]


async def test_a_new_list_requested_in_the_middle_restarts_with_the_new_list(rig: Rig) -> None:
    pub = Pub(rig)
    original = rig.resolver.resolve
    calls: list[str] = []

    async def spying(package: str, version: int | None) -> AppIcon | None:
        calls.append(package)
        if package == CINEVS:
            pub.publisher.request([AppEntry(PLAYER, "Player")])
        return await original(package, version)

    rig.resolver.resolve = spying  # type: ignore[method-assign]
    pub.publisher.request(entries())
    await pub.settle()
    # O CineVS terminou; a lista nova (só o Player) fez o laço recomeçar sem o resto da antiga.
    assert calls.count(PLAYER) == 1
    last = pub.v2()[-1]
    assert [a["package"] for a in last["body"]["apps"]] == [PLAYER]
    assert icon_of(last["body"]["apps"][0]) == ICON_BIG


async def test_a_transport_failure_is_swallowed_and_the_icons_are_sent_again_on_the_next_request(
    rig: Rig,
) -> None:
    pub = Pub(rig)
    failures = {"left": 2}
    real_send = pub.transport.send

    async def flaky(message: dict[str, Any]) -> None:
        if failures["left"]:
            failures["left"] -= 1
            raise TransportError("canal fechado")
        await real_send(message)

    pub.transport.send = flaky  # type: ignore[method-assign]
    pub.publisher.request(entries())
    await pub.settle()
    assert pub.v2() == []
    pub.publisher.request(entries())
    await pub.settle()
    (message,) = pub.v2()
    assert [icon_of(a) for a in message["body"]["apps"]] == [BANNER, ICON_BIG]


async def test_an_unexpected_error_in_the_background_task_does_not_kill_it(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    pub = Pub(rig)
    boom = {"left": 1}
    original = rig.source.package_versions

    async def versions() -> dict[str, int]:
        if boom["left"]:
            boom["left"] -= 1
            raise RuntimeError("falha inesperada")
        return await original()

    rig.source.package_versions = versions  # type: ignore[method-assign]
    pub.publisher.request(entries())
    with caplog.at_level(logging.ERROR):
        await pub.settle()
    assert "ícones" in caplog.text
    pub.publisher.on_state(TvState("on", None, None, "hot"))
    await pub.settle()
    assert len(pub.v2()) == 2


# --- ligação com a lista (`tv.apps.v1` sempre primeiro) ------------------------------------------


class ListEnv:
    def __init__(self, rig: Rig) -> None:
        self.rig = rig
        self.clock = FakeClock()
        self.manager = TvSessionManager(self.clock, FakeTvRemote())
        self.adb = FakeTvAdb(
            [
                LaunchableApp(CINEVS, ".ui.LoginActivity", user_installed=True),
                LaunchableApp(PLAYER, ".Main", user_installed=True),
            ]
        )
        self.pub = Pub(rig)
        self.transport = self.pub.transport
        envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock)
        self.apps = TvApps(self.manager, self.adb, self.transport, envelopes, self.pub.publisher)
        self.refresh = tv_apps_refresh_handler(self.apps)


async def test_the_list_without_icons_is_published_first_and_the_refresh_answers_at_once(
    rig: Rig,
) -> None:
    env = ListEnv(rig)
    result = await env.refresh(Command("0192f1e4-0000-7000-8000-000000000001", "x", {}))
    assert result.status is ResultStatus.OK
    # O pedido já foi respondido e nenhum APK foi tocado: os ícones só rodam na tarefa de fundo.
    assert [m["type"] for m in env.transport.sent] == ["tv.apps.v1"]
    assert rig.source.pulled == []
    assert all("icon" not in app for app in env.transport.sent[0]["body"]["apps"])
    await env.pub.settle()
    assert [m["type"] for m in env.transport.sent] == ["tv.apps.v1", "tv.apps.v2", "tv.apps.v2"]


async def test_without_a_publisher_the_list_works_exactly_as_before(rig: Rig) -> None:
    env = ListEnv(rig)
    envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), env.clock)
    plain = TvApps(env.manager, env.adb, env.transport, envelopes)
    await plain.publish(await plain.refresh())
    assert [m["type"] for m in env.transport.sent] == ["tv.apps.v1"]


def test_the_contract_limit_matches_the_cache_and_the_schema_size() -> None:
    # 32768 bytes viram 43692 caracteres de base64, o `maxLength` do esquema de `tv.apps.v2`.
    assert len(base64.b64encode(b"\x00" * MAX_ICON_BYTES)) == 43692
