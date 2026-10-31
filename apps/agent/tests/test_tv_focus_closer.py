"""Modo Foco: o app de stream em primeiro plano fica e os outros apps de usuário são fechados."""

import asyncio
from collections.abc import Callable

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb
from uniover_agent.core.tv.focus_closer import (
    MIN_INTERVAL_SECONDS,
    RECHECK_SECONDS,
    FocusBackgroundCloser,
    can_close_in_focus,
)
from uniover_agent.core.tv.light_settings import TvLightSettings
from uniover_agent.ports import AdbError, AdbTimeout, LaunchableApp

STREAM = "com.netflix.ninja"
OTHER_STREAM = "com.disney.disneyplus"
MUSIC = "com.spotify.tv.android"
GAME = "com.exemplo.jogo"
LAUNCHER = "com.google.android.tvlauncher"
KEYBOARD = "com.exemplo.teclado"
READER = "com.exemplo.leitor"


def build(
    adb: FakeTvAdb, **extra: object
) -> tuple[FocusBackgroundCloser, FakeClock, list[tuple[tuple[str, ...], int]]]:
    clock = FakeClock()
    reports: list[tuple[tuple[str, ...], int]] = []
    extra.setdefault("foreground", lambda: STREAM)

    async def report(packages: tuple[str, ...], duration_ms: int) -> None:
        reports.append((packages, duration_ms))

    closer = FocusBackgroundCloser(adb, clock, report=report, **extra)  # type: ignore[arg-type]
    closer.configure(True)
    return closer, clock, reports


def tv(*packages: str) -> FakeTvAdb:
    adb = FakeTvAdb(apps=[LaunchableApp(package, ".Main") for package in packages])
    adb.running = frozenset(packages)
    adb.home = frozenset({LAUNCHER})
    adb.keyboard = KEYBOARD
    adb.accessibility = frozenset({READER})
    return adb


class InterruptibleTv(FakeTvAdb):
    """TV em que algo acontece (troca de app, desligar a opção) logo antes de cada fechamento."""

    before_stop: Callable[[str], None] = staticmethod(lambda _package: None)
    while_reading: Callable[[], None] = staticmethod(lambda: None)

    async def running_packages(self) -> frozenset[str]:
        self.while_reading()
        return await super().running_packages()

    async def force_stop(self, package: str) -> None:
        self.before_stop(package)
        await super().force_stop(package)


def interruptible(*packages: str) -> InterruptibleTv:
    adb = InterruptibleTv(apps=[LaunchableApp(package, ".Main") for package in packages])
    adb.running = frozenset(packages)
    adb.home = frozenset({LAUNCHER})
    adb.keyboard = KEYBOARD
    adb.accessibility = frozenset({READER})
    return adb


def stopped(adb: FakeTvAdb) -> list[str]:
    return [
        step.removeprefix("force-stop:")
        for step in adb.cleanup_log
        if step.startswith("force-stop:")
    ]


async def test_closes_the_other_apps_and_keeps_the_foreground_and_the_protected_ones() -> None:
    adb = tv(
        STREAM,
        OTHER_STREAM,
        MUSIC,
        GAME,
        LAUNCHER,
        KEYBOARD,
        READER,
        "com.google.android.gms",
        "com.google.android.tv.remote.service",
        "com.android.systemui",
        "com.android.vending",
        "com.google.android.katniss",
    )
    closer, _, reports = build(adb)

    await closer.on_focus(STREAM)

    assert sorted(stopped(adb)) == sorted([OTHER_STREAM, MUSIC, GAME])
    assert reports[0][0] == (OTHER_STREAM, GAME, MUSIC)


async def test_apps_that_are_not_running_are_left_alone() -> None:
    adb = tv(STREAM, GAME)
    adb.running = frozenset({STREAM})
    closer, _, reports = build(adb)

    await closer.on_focus(STREAM)

    assert stopped(adb) == []
    assert reports == []


async def test_the_keep_list_of_the_owner_is_respected() -> None:
    adb = tv(STREAM, GAME, MUSIC)
    closer, _, _ = build(adb, keep=[GAME])

    await closer.on_focus(STREAM)

    assert stopped(adb) == [MUSIC]


async def test_nothing_happens_when_the_option_is_off() -> None:
    adb = tv(STREAM, GAME)
    closer, _, reports = build(adb)
    closer.configure(False)

    await closer.on_focus(STREAM)

    assert adb.cleanup_log == []
    assert reports == []


async def test_nothing_happens_without_a_foreground_app_or_during_a_cleanup() -> None:
    adb = tv(STREAM, GAME)
    busy = True
    closer, _, _ = build(adb, is_busy=lambda: busy)

    await closer.on_focus(None)
    await closer.on_focus(STREAM)

    assert adb.cleanup_log == []


async def test_debounce_same_app_waits_for_the_recheck_and_a_change_waits_for_the_minimum() -> None:
    adb = tv(STREAM, OTHER_STREAM, GAME)
    screen = {"app": STREAM}
    closer, clock, _ = build(adb, foreground=lambda: screen["app"])

    await closer.on_focus(STREAM)
    first = len(adb.cleanup_log)

    clock.advance(MIN_INTERVAL_SECONDS + 1)
    await closer.on_focus(STREAM)  # mesmo app, cedo demais para conferir de novo
    assert len(adb.cleanup_log) == first

    screen["app"] = OTHER_STREAM
    await closer.on_focus(OTHER_STREAM)  # trocou e o intervalo mínimo já passou
    assert len(adb.cleanup_log) > first
    second = len(adb.cleanup_log)

    screen["app"] = STREAM
    await closer.on_focus(STREAM)  # trocou de novo, só um instante depois
    assert len(adb.cleanup_log) == second

    clock.advance(RECHECK_SECONDS + 1)
    await closer.on_focus(STREAM)
    assert len(adb.cleanup_log) > second


async def test_a_new_entry_into_focus_sweeps_again() -> None:
    adb = tv(STREAM, GAME)
    closer, _, _ = build(adb)

    await closer.on_focus(STREAM)
    closer.reset()
    await closer.on_focus(STREAM)

    assert stopped(adb) == [GAME, GAME]


@pytest.mark.parametrize(
    "missing", ["list-apps", "home-packages", "accessibility", "running", "keyboard"]
)
async def test_a_failed_protection_reading_closes_nothing(missing: str) -> None:
    adb = tv(STREAM, GAME)
    adb.cleanup_errors[missing] = AdbError("sem resposta")
    closer, _, reports = build(adb)

    await closer.on_focus(STREAM)

    assert stopped(adb) == []
    assert reports == []


async def test_a_refusing_app_does_not_stop_the_others_but_a_lost_adb_does() -> None:
    adb = tv(STREAM, GAME, MUSIC)
    adb.cleanup_errors[f"force-stop:{GAME}"] = AdbError("recusou")
    closer, _, reports = build(adb)
    await closer.on_focus(STREAM)
    assert reports[0][0] == (MUSIC,)

    lost = tv(STREAM, GAME, MUSIC)
    lost.cleanup_errors[f"force-stop:{GAME}"] = AdbTimeout("sumiu")
    closer, _, reports = build(lost)
    await closer.on_focus(STREAM)
    assert stopped(lost) == [GAME]
    assert reports == []


@pytest.mark.parametrize(
    "package",
    [
        "android",
        "com.android.systemui",
        "com.android.vending",
        "com.google.android.gms",
        "com.google.android.tv.remote.service",
        "com.google.android.tvlauncher",
        "com.google.android.inputmethod.latin",
        "com.google.android.katniss",
        "com.tcl.settings",
        "com.exemplo.control.remote",
    ],
)
def test_system_google_and_remote_packages_are_never_closed(package: str) -> None:
    assert can_close_in_focus(package) is False


def test_ordinary_apps_can_be_closed_unless_shielded() -> None:
    assert can_close_in_focus(GAME) is True
    assert can_close_in_focus(GAME, {GAME}) is False


async def test_the_light_settings_loop_calls_the_closer_only_while_focus_is_active() -> None:
    adb = tv(STREAM, GAME)
    clock = FakeClock()
    closer = FocusBackgroundCloser(adb, clock, lambda: STREAM)
    closer.configure(True)
    settings = TvLightSettings(
        adb,
        clock,
        lambda _: None,
        lambda: STREAM,
        on_focus=closer.on_focus,
        on_focus_end=closer.reset,
    )
    settings._focus_enabled = True

    adb.media_owners = frozenset()
    await settings._check_focus()
    assert stopped(adb) == []  # sem mídia tocando não há foco

    adb.media_owners = frozenset({STREAM})
    await settings._check_focus()
    assert stopped(adb) == [GAME]

    adb.media_owners = frozenset()
    clock.advance(181)
    await settings._check_focus()  # o foco terminou: o estado do fechador volta ao início
    adb.media_owners = frozenset({STREAM})
    clock.advance(1)
    await settings._check_focus()
    assert stopped(adb) == [GAME, GAME]


async def test_stream_in_front_browsing_while_another_app_plays_closes_nothing() -> None:
    # Netflix na frente, mas quem toca é o Spotify: ninguém está assistindo, então não há foco.
    adb = tv(STREAM, MUSIC, GAME)
    clock = FakeClock()
    holds: list[bool] = []
    closer = FocusBackgroundCloser(adb, clock, lambda: STREAM)
    closer.configure(True)
    settings = TvLightSettings(
        adb,
        clock,
        holds.append,
        lambda: STREAM,
        on_focus=closer.on_focus,
        on_focus_end=closer.reset,
    )
    settings._focus_enabled = True
    adb.media_owners = frozenset({MUSIC})

    await settings._check_focus()

    assert settings.focus_active is False
    assert holds == []
    assert stopped(adb) == []

    # Quando a sessão que toca passa a ser a do app da frente, o foco liga e o fechamento age.
    adb.media_owners = frozenset({STREAM, MUSIC})
    await settings._check_focus()
    assert settings.focus_active is True
    assert sorted(stopped(adb)) == sorted([MUSIC, GAME])


async def test_the_app_that_just_came_to_the_front_is_never_closed() -> None:
    # O foco muda enquanto a varredura ainda lê os processos: o novo app da frente (GAME) estava
    # na lista de candidatos e não pode ser encerrado.
    adb = interruptible(STREAM, GAME, MUSIC)
    screen = {"app": STREAM}
    closer, _, _ = build(adb, foreground=lambda: screen["app"])
    adb.while_reading = lambda: screen.update(app=GAME)

    await closer.on_focus(STREAM)

    assert stopped(adb) == []


async def test_a_change_of_the_front_app_midway_stops_the_rest_of_the_sweep() -> None:
    adb = interruptible(STREAM, GAME, MUSIC)
    screen = {"app": STREAM}
    closer, _, reports = build(adb, foreground=lambda: screen["app"])
    # Candidatos em ordem: GAME, MUSIC. Durante o primeiro fechamento a pessoa abre o MUSIC:
    # o que já estava em andamento termina, o seguinte (o app da frente agora) não acontece.
    adb.before_stop = lambda package: screen.update(app=MUSIC) if package == GAME else None

    await closer.on_focus(STREAM)

    assert stopped(adb) == [GAME]
    assert reports[0][0] == (GAME,)


async def test_an_interrupted_sweep_is_retried_on_the_next_reading() -> None:
    adb = interruptible(STREAM, GAME)
    screen = {"app": STREAM}
    closer, clock, _ = build(adb, foreground=lambda: screen["app"])
    adb.while_reading = lambda: screen.update(app=OTHER_STREAM)
    await closer.on_focus(STREAM)
    assert stopped(adb) == []

    # Voltou ao stream e a leitura seguinte (30 s depois) varre sem esperar a conferência lenta.
    adb.while_reading = lambda: None
    screen["app"] = STREAM
    clock.advance(31)
    await closer.on_focus(STREAM)
    assert stopped(adb) == [GAME]


async def test_an_unreadable_foreground_closes_nothing() -> None:
    adb = tv(STREAM, GAME)
    closer, _, _ = build(adb, foreground=lambda: None)

    await closer.on_focus(STREAM)

    assert stopped(adb) == []


async def test_turning_the_option_off_during_a_sweep_stops_it() -> None:
    adb = interruptible(STREAM, GAME, MUSIC)
    closer, _, _ = build(adb)
    adb.before_stop = lambda _package: closer.configure(False)

    await closer.on_focus(STREAM)

    assert stopped(adb) == [GAME]


async def test_the_end_of_the_focus_during_a_sweep_stops_it() -> None:
    adb = interruptible(STREAM, GAME, MUSIC)
    closer, _, _ = build(adb)
    adb.before_stop = lambda _package: closer.reset()

    await closer.on_focus(STREAM)

    assert stopped(adb) == [GAME]


async def test_a_cleanup_that_starts_during_a_sweep_takes_over() -> None:
    adb = interruptible(STREAM, GAME, MUSIC)
    cleaning = {"running": False}
    closer, _, _ = build(adb, is_busy=lambda: cleaning["running"])
    adb.before_stop = lambda _package: cleaning.update(running=True)

    await closer.on_focus(STREAM)

    assert stopped(adb) == [GAME]


async def test_a_reading_that_arrives_during_a_sweep_does_not_start_another() -> None:
    gate = asyncio.Event()
    started = asyncio.Event()

    class SlowTv(InterruptibleTv):
        async def force_stop(self, package: str) -> None:
            started.set()
            await gate.wait()
            await FakeTvAdb.force_stop(self, package)

    adb = SlowTv(apps=[LaunchableApp(package, ".Main") for package in (STREAM, GAME)])
    adb.running = frozenset({STREAM, GAME})
    closer, clock, _ = build(adb)

    first = asyncio.create_task(closer.on_focus(STREAM))
    await started.wait()
    clock.advance(RECHECK_SECONDS + 1)
    await closer.on_focus(OTHER_STREAM)  # chega no meio da varredura: ignorada
    gate.set()
    await first

    assert stopped(adb) == [GAME]


async def test_media_in_an_app_outside_the_catalog_starts_neither_focus_nor_closing() -> None:
    adb = tv(STREAM, GAME)
    clock = FakeClock()
    closer = FocusBackgroundCloser(adb, clock, lambda: GAME)
    closer.configure(True)
    settings = TvLightSettings(
        adb,
        clock,
        lambda _: None,
        lambda: GAME,
        on_focus=closer.on_focus,
        on_focus_end=closer.reset,
    )
    settings._focus_enabled = True
    adb.media_owners = frozenset({GAME})

    await settings._check_focus()

    assert settings.focus_active is False
    assert stopped(adb) == []
