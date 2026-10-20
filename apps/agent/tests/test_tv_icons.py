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
from uniover_agent.core.tv.icon_badging import MAX_ICON_BYTES, PREFERRED_MAX_SIDE
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
    BADGING_ADAPTIVE_WITH_BANNER,
    BADGING_DENSITIES,
    BADGING_SPOTIFY,
    RESOURCES_CINEVS,
    RESOURCES_SPOTIFY,
    FakeApkSource,
    FakeInspector,
    FolderScratch,
    MemoryIconCache,
    png_bytes,
    webp_bytes,
)

CINEVS = "com.cnvs.apptv"
PLAYER = "com.exemplo.player"
SPOTIFY = "com.spotify.tv.android"
BASE = "/data/app/~~x==/com.cnvs.apptv-y==/base.apk"
PLAYER_BASE = "/data/app/~~p==/com.exemplo.player-q==/base.apk"
PLAYER_SPLIT = "/data/app/~~p==/com.exemplo.player-q==/split_config.xxhdpi.apk"
SPOTIFY_FOLDER = "/data/app/~~s==/com.spotify.tv.android-t=="

BANNER = png_bytes(32, 18)
# O ícone legado do CineVS (o `xxxhdpi` do recurso do XML adaptativo): quadrado de 192 px.
CINEVS_ICON = webp_bytes(192)
ICON_BIG = png_bytes(8, 8)

CINEVS_FALLBACKS = [
    "res/sK.webp",
    "res/Sn.webp",
    "res/qs.webp",
    "res/MO.webp",
    "res/d2.webp",
]
PLAYER_CANDIDATES = [
    "res/mipmap-xxxhdpi-v4/ic_launcher.png",
    "res/mipmap-xxhdpi-v4/ic_launcher.png",
    "res/mipmap-xhdpi-v4/ic_launcher.png",
    "res/mipmap-mdpi-v4/ic_launcher.png",
]


class Rig:
    """Um CineVS (ícone adaptativo; o legado só consta na tabela de recursos, mais um banner PNG)
    e um Player (PNG por densidade), com dublês das portas."""

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
            b"apk-cinevs": BADGING_ADAPTIVE_WITH_BANNER,
            b"apk-player": BADGING_DENSITIES,
        }
        self.inspector.resources = {b"apk-cinevs": RESOURCES_CINEVS}
        self.inspector.members = {
            (b"apk-cinevs", "res/Ec.png"): BANNER,
            (b"apk-cinevs", "res/sK.webp"): CINEVS_ICON,
            (b"apk-cinevs", "res/Sn.webp"): webp_bytes(144),
            (b"apk-cinevs", "res/qs.webp"): webp_bytes(96),
            (b"apk-cinevs", "res/MO.webp"): webp_bytes(72),
            (b"apk-cinevs", "res/d2.webp"): webp_bytes(48),
            # A camada da frente do ícone adaptativo: quadrada, mas não é o ícone.
            (b"apk-cinevs", "res/5c.webp"): webp_bytes(190),
            (b"apk-player", PLAYER_CANDIDATES[0]): ICON_BIG,
        }

    def cinevs_members(self) -> list[tuple[bytes, str]]:
        return [key for key in self.inspector.members if key[0] == b"apk-cinevs"]


@pytest.fixture
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


# --- validação do conteúdo ----------------------------------------------------------------------


def test_validate_icon_accepts_square_png_and_webp_within_the_limit() -> None:
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


def test_validate_icon_refuses_anything_that_is_not_square() -> None:
    assert validate_icon(png_bytes(320, 180)) is None
    assert validate_icon(png_bytes(180, 320)) is None
    assert validate_icon(webp_bytes(320, 180)) is None
    # Sem cabeçalho legível não há como provar que é quadrado: não é publicado.
    assert validate_icon(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 30) is None


# --- resolução ----------------------------------------------------------------------------------


async def test_an_adaptive_only_app_uses_the_square_fallback_from_the_resource_table(
    rig: Rig,
) -> None:
    icon = await rig.resolver.resolve(CINEVS, 50)
    assert icon == AppIcon("image/webp", CINEVS_ICON)
    assert rig.source.pulled == [BASE]
    assert rig.cache.entries == {(CINEVS, 50): icon}
    # Só arquivos do recurso do XML foram lidos de dentro do APK: nem o banner, nem a camada.
    assert rig.inspector.read == CINEVS_FALLBACKS
    assert rig.inspector.resources_dumped == 1
    assert rig.scratch.leftovers() == []


async def test_the_banner_is_never_published_as_an_icon(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    # O APK só tem o banner 16:9 e o XML adaptativo, sem imagem legada: fica sem ícone.
    rig.inspector.resources.clear()
    with caplog.at_level(logging.INFO):
        assert await rig.resolver.resolve(CINEVS, 50) is None
    assert "res/Ec.png" not in rig.inspector.read
    assert rig.inspector.read == []
    assert rig.cache.entries == {(CINEVS, 50): None}
    assert f"{CINEVS} ficou sem ícone: ícone adaptativo (XML) sem imagem PNG/WebP de reserva" in (
        caplog.text
    )
    assert rig.scratch.leftovers() == []


async def test_a_non_square_launcher_image_is_rejected_and_the_reason_is_logged(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    for name in PLAYER_CANDIDATES:
        rig.inspector.members[(b"apk-player", name)] = png_bytes(320, 180)
    with caplog.at_level(logging.INFO):
        assert await rig.resolver.resolve(PLAYER, 7) is None
    assert rig.cache.entries == {(PLAYER, 7): None}
    assert f"{PLAYER} ficou sem ícone: só há imagem não quadrada (4 de 4 testadas)" in caplog.text
    # A imagem em si nunca vai para o registro.
    assert base64.b64encode(png_bytes(320, 180)).decode() not in caplog.text


async def test_a_square_image_wins_over_a_non_square_one_listed_before_it(rig: Rig) -> None:
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[0])] = png_bytes(320, 180)
    square = png_bytes(96, 96)
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[1])] = square
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", square)


async def test_the_resource_table_is_not_dumped_when_the_badging_already_gives_a_square(
    rig: Rig,
) -> None:
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", ICON_BIG)
    assert rig.inspector.resources_dumped == 0


async def test_the_largest_square_up_to_the_preferred_side_wins(rig: Rig) -> None:
    sizes = [PREFERRED_MAX_SIDE + 128, PREFERRED_MAX_SIDE + 48, PREFERRED_MAX_SIDE, 160]
    for name, side in zip(PLAYER_CANDIDATES, sizes, strict=True):
        rig.inspector.members[(b"apk-player", name)] = png_bytes(side, side)
    chosen = await rig.resolver.resolve(PLAYER, 7)
    assert chosen == AppIcon("image/png", png_bytes(PREFERRED_MAX_SIDE, PREFERRED_MAX_SIDE))
    assert rig.inspector.read == PLAYER_CANDIDATES


async def test_when_every_square_is_above_the_preferred_side_the_smallest_one_wins(
    rig: Rig,
) -> None:
    for name, side in zip(PLAYER_CANDIDATES, [512, 320, 256, 400], strict=True):
        rig.inspector.members[(b"apk-player", name)] = png_bytes(side, side)
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", png_bytes(256, 256))


async def test_a_tie_in_size_keeps_the_higher_density_candidate(rig: Rig) -> None:
    first, second = png_bytes(96, 96, pad_to=300), png_bytes(96, 96, pad_to=400)
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[0])] = first
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[1])] = second
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", first)


async def test_a_too_big_image_is_skipped_and_the_next_one_is_used(rig: Rig) -> None:
    huge = png_bytes(180, 180, pad_to=MAX_ICON_BYTES + 100)
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[0])] = huge
    # O `read_member` do dublê já recusa o que passa do limite, como o adaptador real.
    medium = png_bytes(6, 6)
    rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[1])] = medium
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", medium)


async def test_when_nothing_fits_the_size_limit_the_app_has_no_icon_and_says_why(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    for name in PLAYER_CANDIDATES:
        rig.inspector.members[(b"apk-player", name)] = png_bytes(
            180, 180, pad_to=MAX_ICON_BYTES + 1
        )
    with caplog.at_level(logging.INFO):
        assert await rig.resolver.resolve(PLAYER, 7) is None
    assert "as imagens de ícone não estão no APK ou passam do limite de tamanho" in caplog.text


async def test_files_that_are_not_images_are_reported_as_unreadable(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    for name in PLAYER_CANDIDATES:
        rig.inspector.members[(b"apk-player", name)] = b"<vector/>"
    with caplog.at_level(logging.INFO):
        assert await rig.resolver.resolve(PLAYER, 7) is None
    assert "nenhuma imagem de ícone legível" in caplog.text


async def test_an_apk_that_declares_no_icon_image_at_all_is_reported(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.inspector.badging[b"apk-player"] = "package: name='com.exemplo.player' versionCode='7'\n"
    with caplog.at_level(logging.INFO):
        assert await rig.resolver.resolve(PLAYER, 7) is None
    assert "o APK não declara imagem PNG/WebP de ícone" in caplog.text
    assert rig.inspector.resources_dumped == 0


async def test_the_chosen_file_and_size_go_to_the_debug_log_without_the_image(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        await rig.resolver.resolve(CINEVS, 50)
    assert f"ícone de {CINEVS}: res/sK.webp, 192x192, {len(CINEVS_ICON)} bytes" in caplog.text
    assert base64.b64encode(CINEVS_ICON).decode() not in caplog.text


async def test_a_cache_hit_does_not_touch_the_tv(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/webp", CINEVS_ICON)
    cached = rig.resolver.cached(CINEVS, 50)
    assert cached == CachedIcon(AppIcon("image/webp", CINEVS_ICON))
    assert rig.source.pulled == []


async def test_a_banner_kept_in_the_cache_by_the_old_rule_counts_as_never_downloaded(
    rig: Rig,
) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/png", png_bytes(320, 180))
    assert rig.resolver.cached(CINEVS, 50) is None
    # Resolvido de novo, o ícone quadrado substitui o banner.
    assert await rig.resolver.resolve(CINEVS, 50) == AppIcon("image/webp", CINEVS_ICON)
    assert rig.cache.entries == {(CINEVS, 50): AppIcon("image/webp", CINEVS_ICON)}


async def test_a_new_version_misses_the_cache_and_replaces_the_old_entry(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 49)] = AppIcon("image/png", png_bytes(2, 2))
    assert rig.resolver.cached(CINEVS, 50) is None
    await rig.resolver.resolve(CINEVS, 50)
    assert list(rig.cache.entries) == [(CINEVS, 50)]


async def test_an_app_without_usable_image_is_cached_as_no_icon(rig: Rig) -> None:
    for key in rig.cinevs_members():
        del rig.inspector.members[key]
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
        "application: label='A' icon='res/x.png' banner='res/Ec.png'\n"
    )
    rig.inspector.members[(b"apk-cinevs", "res/x.png")] = png_bytes(64, 64)
    assert await rig.resolver.resolve(CINEVS, None) == AppIcon("image/png", png_bytes(64, 64))
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


async def test_a_broken_resource_dump_raises_and_nothing_is_cached(rig: Rig) -> None:
    rig.inspector.resources_error = IconToolError("o aapt2 não conseguiu ler o APK")
    with pytest.raises(IconToolError):
        await rig.resolver.resolve(CINEVS, 50)
    assert rig.cache.entries == {}
    assert rig.scratch.leftovers() == []


async def test_density_split_is_searched_only_when_the_base_has_no_usable_image(rig: Rig) -> None:
    rig.source.paths[PLAYER] = [PLAYER_BASE, "/data/app/~~p==/x/split_config.pt.apk", PLAYER_SPLIT]
    rig.source.apks[PLAYER_SPLIT] = b"split-xxhdpi"
    del rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[0])]
    in_split = png_bytes(5, 5)
    rig.inspector.members[(b"split-xxhdpi", PLAYER_CANDIDATES[1])] = in_split
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", in_split)
    # Só o APK de densidade foi copiado além do base; o de idioma (`pt`) nunca.
    assert rig.source.pulled == [PLAYER_BASE, PLAYER_SPLIT]
    assert rig.scratch.leftovers() == []


async def test_density_split_is_not_pulled_when_the_base_already_has_the_icon(rig: Rig) -> None:
    rig.source.paths[PLAYER] = [PLAYER_BASE, PLAYER_SPLIT]
    await rig.resolver.resolve(PLAYER, 7)
    assert rig.source.pulled == [PLAYER_BASE]


async def test_density_splits_are_all_tried_and_a_square_in_a_later_one_still_counts(
    rig: Rig,
) -> None:
    xxhdpi = "/data/app/~~p==/x/split_config.xxhdpi.apk"
    hdpi = "/data/app/~~p==/x/split_config.hdpi.apk"
    rig.source.paths[PLAYER] = [PLAYER_BASE, hdpi, xxhdpi]
    rig.source.apks[xxhdpi] = b"split-xxhdpi"
    rig.source.apks[hdpi] = b"split-hdpi"
    del rig.inspector.members[(b"apk-player", PLAYER_CANDIDATES[0])]
    rig.inspector.members[(b"split-xxhdpi", PLAYER_CANDIDATES[1])] = png_bytes(320, 180)
    only_square = png_bytes(72, 72)
    rig.inspector.members[(b"split-hdpi", PLAYER_CANDIDATES[2])] = only_square
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", only_square)
    assert rig.source.pulled == [PLAYER_BASE, xxhdpi, hdpi]


# --- APKs divididos: o ícone sai do `base.apk` --------------------------------------------------


def spotify_rig(tmp_path: Path, paths: list[str]) -> Rig:
    """O Spotify real: ícone adaptativo; a reserva em PNG está no `base.apk`, não nos `split_*`."""
    rig = Rig(tmp_path)
    rig.source.versions[SPOTIFY] = 2340200
    rig.source.paths[SPOTIFY] = paths
    for path in paths:
        rig.source.apks[path] = b"apk-" + path.rsplit("/", 1)[1].encode()
    rig.inspector.badging[b"apk-base.apk"] = BADGING_SPOTIFY
    rig.inspector.resources[b"apk-base.apk"] = RESOURCES_SPOTIFY
    for density, side in [("mdpi", 80), ("hdpi", 120), ("xhdpi", 160), ("xxhdpi", 240)]:
        name = f"res/mipmap-{density}-v4/spotify_icon.png"
        rig.inspector.members[(b"apk-base.apk", name)] = png_bytes(side, side)
    rig.inspector.members[(b"apk-base.apk", "res/mipmap-xxxhdpi-v4/spotify_icon.png")] = png_bytes(
        320, 320
    )
    rig.inspector.members[(b"apk-base.apk", "res/banner.png")] = BANNER
    return rig


async def test_a_split_app_takes_the_icon_from_the_base_apk_and_pulls_nothing_else(
    tmp_path: Path,
) -> None:
    # `pm path` entrega o `base.apk` primeiro, mas a escolha não pode depender da ordem.
    paths = [
        f"{SPOTIFY_FOLDER}/split_config.es.apk",
        f"{SPOTIFY_FOLDER}/split_config.tvdpi.apk",
        f"{SPOTIFY_FOLDER}/base.apk",
        f"{SPOTIFY_FOLDER}/split_config.armeabi_v7a.apk",
    ]
    rig = spotify_rig(tmp_path, paths)
    icon = await rig.resolver.resolve(SPOTIFY, 2340200)
    # O ícone legado em PNG (320 px passa de 192: vale o de 160, o maior que respeita o lado).
    assert icon == AppIcon("image/png", png_bytes(160, 160))
    assert rig.source.pulled == [f"{SPOTIFY_FOLDER}/base.apk"]
    assert "res/banner.png" not in rig.inspector.read
    assert rig.scratch.leftovers() == []


async def test_a_system_app_without_a_base_apk_uses_its_only_apk(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    settings = "/system_ext/priv-app/TvSettings/TvSettings.apk"
    rig.source.paths[PLAYER] = [settings]
    rig.source.apks[settings] = b"apk-player"
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", ICON_BIG)
    assert rig.source.pulled == [settings]


async def test_without_a_base_apk_the_first_non_split_apk_is_the_main_one(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    language = "/data/app/~~p==/x/split_config.pt.apk"
    other = "/data/app/~~p==/x/principal.apk"
    rig.source.paths[PLAYER] = [language, other]
    rig.source.apks[language] = b"split-pt"
    rig.source.apks[other] = b"apk-player"
    assert await rig.resolver.resolve(PLAYER, 7) == AppIcon("image/png", ICON_BIG)
    assert rig.source.pulled == [other]


async def test_with_only_split_apks_the_first_one_is_looked_at(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    only = "/data/app/~~p==/x/split_config.pt.apk"
    rig.source.paths[PLAYER] = [only]
    rig.source.apks[only] = b"split-pt"
    assert await rig.resolver.resolve(PLAYER, 7) is None
    assert rig.source.pulled == [only]


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
    assert [icon_of(a) for a in first["body"]["apps"]] == [CINEVS_ICON, None]
    assert [icon_of(a) for a in second["body"]["apps"]] == [None, ICON_BIG]
    assert first["body"]["apps"][0]["icon"]["mime"] == "image/webp"
    # Um respiro antes de cada APK (nada de rajada contra a TV, que tem pouca memória).
    assert pub.clock.sleeps == [0.25, 0.25]
    assert rig.scratch.leftovers() == []


async def test_cached_icons_go_out_first_in_a_single_message_without_pulling(rig: Rig) -> None:
    rig.cache.entries[(CINEVS, 50)] = AppIcon("image/webp", CINEVS_ICON)
    rig.cache.entries[(PLAYER, 7)] = AppIcon("image/png", ICON_BIG)
    pub = Pub(rig)
    pub.publisher.request(entries())
    await pub.settle()
    (message,) = pub.v2()
    assert [icon_of(a) for a in message["body"]["apps"]] == [CINEVS_ICON, ICON_BIG]
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
    assert [icon_of(a) for a in message["body"]["apps"]] == [CINEVS_ICON, ICON_BIG]
    assert rig.source.pulled == pulled


async def test_an_app_with_no_usable_image_stays_in_the_list_without_the_icon_field(
    rig: Rig,
) -> None:
    for key in rig.cinevs_members():
        del rig.inspector.members[key]
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
    assert [icon_of(a) for a in message["body"]["apps"]] == [CINEVS_ICON, ICON_BIG]


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
