"""O catálogo do Modo Foco que a API manda por TV.

O agente antigo (e a TV sem lista própria) segue com a lista de fábrica; o agente novo usa o que
chegar em `focusPackages`, e a detecção automática e a ativação manual continuam valendo.
"""

import re
from pathlib import Path

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb
from uniover_agent.core.tv.light_settings import (
    VIDEO_PACKAGES,
    TvLightSettings,
    focus_catalog_from,
)

CUSTOM = "com.exemplo.cinema"
OTHER = "com.exemplo.musica"
API_SOURCE = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "api"
    / "src"
    / "Modules"
    / "Tv"
    / "UniOver.Modules.Tv"
    / "Domain"
    / "ConfiguredTv.cs"
)


def make(front: str) -> tuple[TvLightSettings, FakeTvAdb]:
    adb = FakeTvAdb()
    settings = TvLightSettings(adb, FakeClock(), lambda _: None, lambda: front)
    adb.media_owners = frozenset({front})
    return settings, adb


async def test_an_app_added_to_the_catalog_turns_the_focus_on_by_itself() -> None:
    settings, _ = make(CUSTOM)

    await settings.configure(True, False, [], [CUSTOM])
    await settings._check_focus()

    assert settings.focus_active is True


async def test_an_app_removed_from_the_catalog_no_longer_turns_the_focus_on() -> None:
    settings, _ = make("com.netflix.ninja")

    await settings.configure(True, False, [], [CUSTOM])
    await settings._check_focus()

    assert settings.focus_active is False


async def test_without_the_field_the_factory_list_still_works() -> None:
    settings, _ = make("com.netflix.ninja")

    await settings.configure(True, False, [])
    await settings._check_focus()

    assert settings.focus_active is True


async def test_a_message_without_the_field_returns_to_the_factory_list() -> None:
    settings, _ = make("com.netflix.ninja")
    await settings.configure(True, False, [], [CUSTOM])

    await settings.configure(True, False, [], None)
    await settings._check_focus()

    assert settings.focus_active is True


async def test_an_empty_catalog_detects_nothing_but_leaves_the_focus_enabled() -> None:
    settings, _ = make("com.netflix.ninja")

    await settings.configure(True, False, [], [])
    await settings._check_focus()

    assert settings.focus_active is False
    assert settings._focus_enabled is True


async def test_the_catalog_only_matters_for_the_app_that_owns_the_playing_session() -> None:
    settings, adb = make(CUSTOM)
    adb.media_owners = frozenset({OTHER})

    await settings.configure(True, False, [], [CUSTOM])
    await settings._check_focus()

    assert settings.focus_active is False


def test_items_that_are_not_package_names_are_ignored_not_fatal() -> None:
    assert focus_catalog_from([CUSTOM, "", "sem ponto", 7, None, "a" * 300 + ".b"]) == {CUSTOM}


def test_a_value_that_is_not_a_list_means_the_factory_list() -> None:
    assert focus_catalog_from(None) == VIDEO_PACKAGES
    assert focus_catalog_from("com.exemplo.cinema") == VIDEO_PACKAGES


def test_the_factory_list_is_the_same_one_the_api_shows_as_default() -> None:
    # A API guarda a lista de fábrica para mostrar "voltar ao padrão"; se as duas divergirem, a tela
    # mente.
    assert API_SOURCE.is_file(), "a fonte da API deveria estar no mesmo repositório"
    source = API_SOURCE.read_text(encoding="utf-8")
    block = source.split("DefaultFocusPackages { get; } =", 1)[1].split("];", 1)[0]
    assert set(re.findall(r'"([^"]+)"', block)) == set(VIDEO_PACKAGES)
