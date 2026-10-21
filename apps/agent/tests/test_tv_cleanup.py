"""Limpeza da TV (núcleo): sequência, lista protegida, falha no meio, tempo e resposta à API.

O ADB é o dublê `FakeTvAdb`; nenhum teste fala com a TV. O `argv` exato que o adaptador manda ao
`adb` está em `test_tv_adb_cleanup.py`.
"""

import asyncio
import logging
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb
from uniover_agent.core import (
    CLEANUP_FAILED,
    CLEANUP_IN_PROGRESS,
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    Handler,
    ResultStatus,
    TvCleanup,
    TvSessionError,
    is_protected,
    tv_cleanup_handler,
)
from uniover_agent.core.tv.cleanup import PROTECTED_PACKAGES
from uniover_agent.ports import (
    AdbCommandFailed,
    AdbError,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
    TransportError,
)

from .support import AGENT_ID

REQUEST_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"
COMMAND_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f"

CINEVS = "com.cnvs.apptv"
SPOTIFY = "com.spotify.tv.android"
PLAY_STORE = "com.android.vending"
YOUTUBE = "com.google.android.youtube.tv"
SETTINGS = "com.android.tv.settings"
LAUNCHER = "com.google.android.tvlauncher"
REMOTE_SERVICE = "com.google.android.tv.remote.service"

# O que a TV real lista para abrir (amostra colhida dela): apps do dono, da TV e peças da TCL.
LAUNCHABLE = [
    LaunchableApp(SETTINGS, ".MainSettings"),
    LaunchableApp(PLAY_STORE, "com.google.android.finsky.tvmainactivity.TvMainActivity"),
    LaunchableApp(YOUTUBE, "com.google.android.apps.youtube.tv.activity.ShellActivity"),
    LaunchableApp("com.tcl.suspension", ".ui.main.MainActivity"),
    LaunchableApp("com.tcl.partnercustomizer", ".tkey.WithIcon"),
    LaunchableApp(CINEVS, ".ui.LoginActivity", user_installed=True),
    LaunchableApp(SPOTIFY, ".SpotifyTVActivity", user_installed=True),
]
EVERYTHING_RUNNING = frozenset(app.package for app in LAUNCHABLE) | {LAUNCHER, REMOTE_SERVICE}

# Na ordem em que a TV lista os apps: o que o dono pode ver fechado.
CLOSABLE = [PLAY_STORE, YOUTUBE, CINEVS, SPOTIFY]


def tv(apps: list[LaunchableApp] | None = None, running: frozenset[str] | None = None) -> FakeTvAdb:
    adb = FakeTvAdb(LAUNCHABLE if apps is None else apps)
    adb.running = EVERYTHING_RUNNING if running is None else running
    return adb


def stops(adb: FakeTvAdb) -> list[str]:
    return [step.removeprefix("force-stop:") for step in adb.cleanup_log if "force-stop" in step]


# --- a sequência --------------------------------------------------------------------------------


async def test_a_cleanup_runs_the_steps_in_order_and_reports_the_memory() -> None:
    adb = tv()
    clock = FakeClock()
    report = await TvCleanup(adb, clock).run()
    assert adb.cleanup_log == [
        "memory",
        "list-apps",
        "home-packages",
        "keyboard",
        "accessibility",
        "running",
        "go-home",
        "kill-background",
        *(f"force-stop:{package}" for package in CLOSABLE),
        "memory",
    ]
    assert report.closed_apps == len(CLOSABLE)
    assert (report.memory_before_mb, report.memory_after_mb, report.freed_mb) == (300, 700, 400)
    assert report.failed_steps == ()
    # Uma pausa depois de HOME (o app da frente vai para o fundo) e outra antes da leitura final.
    assert clock.sleeps == [1.0, 1.0]


async def test_the_second_cleanup_finds_nothing_open_and_closes_nothing() -> None:
    adb = tv()
    cleanup = TvCleanup(adb, FakeClock())
    await cleanup.run()
    adb.running = frozenset({LAUNCHER, REMOTE_SERVICE, SETTINGS})  # só o que é protegido segue vivo
    adb.cleanup_log.clear()
    adb.memory_mb = [700, 705]
    again = await cleanup.run()
    assert again.closed_apps == 0
    assert stops(adb) == []
    assert again.failed_steps == ()
    assert again.freed_mb == 5
    # O que não está aberto não leva `force-stop` (ele cancelaria alarmes e avisos do app parado).
    assert "kill-background" in adb.cleanup_log


async def test_only_apps_that_are_running_are_stopped_and_counted() -> None:
    adb = tv(running=frozenset({CINEVS, YOUTUBE}))
    report = await TvCleanup(adb, FakeClock()).run()
    assert stops(adb) == [YOUTUBE, CINEVS]
    assert report.closed_apps == 2


async def test_nothing_is_stopped_when_the_tv_lists_no_app() -> None:
    adb = tv(apps=[])
    report = await TvCleanup(adb, FakeClock()).run()
    assert report.closed_apps == 0
    assert stops(adb) == []


# --- o que nunca se fecha ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "package",
    [
        "android",
        "com.android.systemui",
        SETTINGS,
        "com.android.settings",
        "com.google.android.gms",
        "com.google.android.gsf",
        "com.google.android.tvrecommendations",
        REMOTE_SERVICE,
        "com.android.providers.media",
        "com.android.providers.tv",
        "com.tcl.suspension",
        "com.tcl.guard",
        "com.mediatek.fwk",
        "com.droidlogic.tv",
        "com.exemplo.RemoteControl",
        "com.exemplo.remotecast",
        "com.google.android.tv.remote.service.extra",
    ],
)
def test_protected_packages_are_never_closable(package: str) -> None:
    assert is_protected(package)


@pytest.mark.parametrize("package", [CINEVS, SPOTIFY, PLAY_STORE, YOUTUBE, "com.netflix.ninja"])
def test_ordinary_apps_are_closable(package: str) -> None:
    assert not is_protected(package)


async def test_no_protected_package_ever_gets_a_force_stop() -> None:
    apps = [
        *LAUNCHABLE,
        LaunchableApp("com.android.systemui", ".Main"),
        LaunchableApp("com.google.android.gms", ".Main"),
        LaunchableApp("com.android.providers.tv", ".Main"),
        LaunchableApp(REMOTE_SERVICE, ".RemoteService"),
        LaunchableApp(LAUNCHER, ".MainActivity"),
        LaunchableApp("com.exemplo.keyboard", ".Settings"),
        LaunchableApp("com.exemplo.reader", ".Access"),
        LaunchableApp("com.exemplo.dono", ".Main"),
    ]
    adb = tv(apps=apps, running=frozenset(app.package for app in apps))
    adb.keyboard = "com.exemplo.keyboard"
    adb.accessibility = frozenset({"com.exemplo.reader"})
    await TvCleanup(adb, FakeClock(), keep=["com.exemplo.dono"]).run()
    assert stops(adb) == CLOSABLE
    for package in PROTECTED_PACKAGES | {LAUNCHER, "com.exemplo.keyboard", "com.exemplo.reader"}:
        assert f"force-stop:{package}" not in adb.cleanup_log
    assert "force-stop:com.exemplo.dono" not in adb.cleanup_log


async def test_the_home_screen_the_tv_reports_is_protected() -> None:
    adb = tv(
        apps=[*LAUNCHABLE, LaunchableApp("com.exemplo.tela", ".Inicio")],
        running=EVERYTHING_RUNNING | {"com.exemplo.tela"},
    )
    adb.home = frozenset({"com.exemplo.tela"})
    await TvCleanup(adb, FakeClock()).run()
    assert "com.exemplo.tela" not in stops(adb)


async def test_the_keep_list_of_the_owner_is_respected() -> None:
    adb = tv()
    await TvCleanup(adb, FakeClock(), keep={SPOTIFY, CINEVS}).run()
    assert stops(adb) == [PLAY_STORE, YOUTUBE]


# --- falha ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (AdbUnavailable("o adb não foi encontrado neste PC"), "adb_unavailable"),
        (AdbUnreachable("a TV não respondeu pelo ADB"), "adb_unreachable"),
        (AdbUnauthorized("a TV ainda não autorizou este PC no ADB"), "adb_unauthorized"),
        (AdbTimeout("a TV demorou demais para responder ao ADB"), "adb_timeout"),
        (AdbCommandFailed("a TV não respondeu"), "adb_failed"),
    ],
)
async def test_without_the_adb_nothing_is_done_and_the_reason_is_a_stable_code(
    error: AdbError, code: str
) -> None:
    adb = tv()
    adb.cleanup_errors["memory"] = error
    with pytest.raises(TvSessionError) as caught:
        await TvCleanup(adb, FakeClock()).run()
    assert caught.value.code == code
    assert caught.value.message == error.message
    # Nem HOME nem `force-stop`: o primeiro comando é o teste do canal.
    assert adb.cleanup_log == ["memory"]


async def test_one_app_that_will_not_close_does_not_stop_the_others() -> None:
    adb = tv()
    adb.cleanup_errors[f"force-stop:{YOUTUBE}"] = AdbCommandFailed("a TV não fechou o app")
    report = await TvCleanup(adb, FakeClock()).run()
    assert stops(adb) == CLOSABLE
    assert report.closed_apps == len(CLOSABLE) - 1
    assert report.failed_steps == (f"force-stop:{YOUTUBE}",)
    assert report.memory_after_mb == 700


@pytest.mark.parametrize("error_type", [AdbUnreachable, AdbTimeout, AdbUnauthorized])
async def test_losing_the_adb_in_the_middle_stops_and_says_so(error_type: type[AdbError]) -> None:
    adb = tv()
    adb.cleanup_errors[f"force-stop:{YOUTUBE}"] = error_type("falha")
    report = await TvCleanup(adb, FakeClock()).run()
    # O Play Store fechou; o YouTube falhou e a limpeza parou ali (nada de insistir numa TV muda).
    assert stops(adb) == [PLAY_STORE, YOUTUBE]
    assert report.closed_apps == 1
    assert report.failed_steps == (f"force-stop:{YOUTUBE}", "adb-lost")
    assert report.memory_after_mb is None
    assert report.freed_mb is None
    assert adb.cleanup_log[-1] == f"force-stop:{YOUTUBE}"


@pytest.mark.parametrize(
    ("step", "failed"),
    [
        ("list-apps", "list-apps"),
        ("home-packages", "read-protected"),
        ("keyboard", "read-protected"),
        ("accessibility", "read-protected"),
        ("running", "read-running"),
    ],
)
async def test_if_what_protects_or_what_runs_cannot_be_read_no_app_is_closed(
    step: str, failed: str
) -> None:
    adb = tv()
    adb.cleanup_errors[step] = AdbCommandFailed("a TV não informou")
    report = await TvCleanup(adb, FakeClock()).run()
    assert stops(adb) == []
    assert report.closed_apps == 0
    assert report.failed_steps == (failed,)
    # O que não depende dessa leitura segue: HOME, `kill-all` e a memória final.
    assert "go-home" in adb.cleanup_log
    assert "kill-background" in adb.cleanup_log
    assert report.memory_after_mb == 700


async def test_a_failing_home_key_does_not_cancel_the_rest() -> None:
    adb = tv()
    adb.cleanup_errors["go-home"] = AdbCommandFailed("a TV não foi para a tela inicial")
    report = await TvCleanup(adb, FakeClock()).run()
    assert report.failed_steps == ("go-home",)
    assert report.closed_apps == len(CLOSABLE)
    assert "kill-background" in adb.cleanup_log


async def test_a_failing_kill_all_does_not_cancel_the_force_stops() -> None:
    adb = tv()
    adb.cleanup_errors["kill-background"] = AdbCommandFailed("a TV não encerrou os processos")
    report = await TvCleanup(adb, FakeClock()).run()
    assert report.failed_steps == ("kill-background",)
    assert report.closed_apps == len(CLOSABLE)


async def test_losing_the_adb_while_reading_skips_every_later_step() -> None:
    adb = tv()
    adb.cleanup_errors["list-apps"] = AdbUnreachable("a TV não respondeu pelo ADB")
    report = await TvCleanup(adb, FakeClock()).run()
    assert adb.cleanup_log == ["memory", "list-apps"]
    assert report.failed_steps == ("list-apps", "adb-lost")
    assert (report.closed_apps, report.memory_after_mb) == (0, None)


# --- memória ------------------------------------------------------------------------------------


async def test_memory_that_cannot_be_measured_is_reported_as_unknown() -> None:
    adb = tv()
    adb.memory_mb = [None]
    report = await TvCleanup(adb, FakeClock()).run()
    assert (report.memory_before_mb, report.memory_after_mb, report.freed_mb) == (None, None, None)
    assert report.closed_apps == len(CLOSABLE)
    assert report.failed_steps == ()


async def test_only_the_final_reading_missing_leaves_the_freed_amount_unknown() -> None:
    adb = tv()
    adb.memory_mb = [300, None]
    report = await TvCleanup(adb, FakeClock()).run()
    assert (report.memory_before_mb, report.memory_after_mb, report.freed_mb) == (300, None, None)


async def test_the_freed_amount_is_never_negative() -> None:
    adb = tv()
    adb.memory_mb = [700, 300]
    report = await TvCleanup(adb, FakeClock()).run()
    assert (report.memory_before_mb, report.memory_after_mb, report.freed_mb) == (700, 300, 0)


# --- tempo e concorrência ----------------------------------------------------------------------


async def test_when_the_time_budget_ends_the_rest_is_skipped_and_reported() -> None:
    adb = tv()
    # O orçamento acaba durante a pausa depois de HOME: nada de `kill-all` nem de `force-stop`.
    report = await TvCleanup(adb, FakeClock(), budget_seconds=0.5).run()
    assert stops(adb) == []
    assert "kill-background" not in adb.cleanup_log
    assert report.failed_steps == ("deadline",)
    assert report.memory_after_mb == 700


async def test_the_budget_can_end_between_two_apps() -> None:
    class Slow(FakeTvAdb):
        def __init__(self, clock: FakeClock) -> None:
            super().__init__(LAUNCHABLE)
            self.running = EVERYTHING_RUNNING
            self._clock = clock

        async def force_stop(self, package: str) -> None:
            await super().force_stop(package)
            self._clock.advance(4.0)

    clock = FakeClock()
    adb = Slow(clock)
    report = await TvCleanup(adb, clock, budget_seconds=6.0, settle_seconds=0.0).run()
    assert stops(adb) == CLOSABLE[:2]
    assert report.closed_apps == 2
    assert report.failed_steps == ("deadline",)


async def test_a_second_cleanup_while_one_runs_is_refused() -> None:
    gate = asyncio.Event()

    class Waiting(FakeTvAdb):
        async def memory_available_mb(self) -> int | None:
            await gate.wait()
            return await super().memory_available_mb()

    adb = Waiting(LAUNCHABLE)
    adb.running = EVERYTHING_RUNNING
    cleanup = TvCleanup(adb, FakeClock())
    first = asyncio.create_task(cleanup.run())
    await asyncio.sleep(0)
    assert cleanup.running
    with pytest.raises(TvSessionError) as caught:
        await cleanup.run()
    assert caught.value.code == CLEANUP_IN_PROGRESS
    gate.set()
    assert (await first).closed_apps == len(CLOSABLE)
    assert not cleanup.running
    # Terminada a primeira, outra pode rodar.
    assert (await cleanup.run()).closed_apps == len(CLOSABLE)


async def test_a_failed_cleanup_frees_the_turn_for_the_next() -> None:
    adb = tv()
    adb.cleanup_errors["memory"] = AdbUnreachable("a TV não respondeu pelo ADB")
    cleanup = TvCleanup(adb, FakeClock())
    with pytest.raises(TvSessionError):
        await cleanup.run()
    assert not cleanup.running


# --- a resposta à API ---------------------------------------------------------------------------


def handler_for(adb: FakeTvAdb) -> tuple[Handler, FakeTransport]:
    clock = FakeClock()
    gate = EnvelopeGate(AGENT_ID)
    transport = FakeTransport()
    handler = tv_cleanup_handler(
        TvCleanup(adb, clock), transport, EnvelopeFactory(AGENT_ID, gate, clock)
    )
    return handler, transport


def command(body: dict[str, object] | None = None) -> Command:
    return Command(COMMAND_ID, "tv.cleanup.v1", {"requestId": REQUEST_ID} if body is None else body)


async def test_the_report_goes_to_the_api_before_the_command_is_answered() -> None:
    adb = tv()
    handler, transport = handler_for(adb)
    result = await handler(command())
    assert result.status is ResultStatus.OK
    (report,) = transport.sent
    assert report["type"] == "tv.cleanup.result.v1"
    assert report["correlationId"] == COMMAND_ID
    body = report["body"]
    assert body["requestId"] == REQUEST_ID
    assert body["closedApps"] == len(CLOSABLE)
    assert (body["memoryBeforeMb"], body["memoryAfterMb"], body["freedMb"]) == (300, 700, 400)
    assert body["failedSteps"] == []


async def test_without_the_adb_the_answer_is_a_failure_with_a_stable_code_and_no_report() -> None:
    adb = tv()
    adb.cleanup_errors["memory"] = AdbUnreachable("a TV não respondeu pelo ADB")
    handler, transport = handler_for(adb)
    result = await handler(command())
    assert result.status is ResultStatus.FAILED
    assert result.code == "adb_unreachable"
    assert result.detail == "a TV não respondeu pelo ADB"
    assert transport.sent == []


async def test_a_request_without_id_is_rejected_before_touching_the_tv() -> None:
    adb = tv()
    handler, transport = handler_for(adb)
    result = await handler(command({}))
    assert result.status is ResultStatus.REJECTED
    assert adb.cleanup_log == []
    assert transport.sent == []


async def test_a_second_request_while_cleaning_answers_with_the_in_progress_code() -> None:
    gate = asyncio.Event()

    class Waiting(FakeTvAdb):
        async def memory_available_mb(self) -> int | None:
            await gate.wait()
            return await super().memory_available_mb()

    adb = Waiting(LAUNCHABLE)
    adb.running = EVERYTHING_RUNNING
    handler, transport = handler_for(adb)
    first = asyncio.ensure_future(handler(command()))
    await asyncio.sleep(0)
    second = await handler(command())
    assert (second.status, second.code) == (ResultStatus.FAILED, CLEANUP_IN_PROGRESS)
    gate.set()
    assert (await first).status is ResultStatus.OK
    assert len(transport.sent) == 1


async def test_an_unexpected_error_never_escapes_and_does_not_leak_its_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Broken(FakeTvAdb):
        async def go_home(self) -> None:
            raise RuntimeError("segredo-interno")

    adb = Broken(LAUNCHABLE)
    adb.running = EVERYTHING_RUNNING
    handler, transport = handler_for(adb)
    with caplog.at_level(logging.ERROR):
        result = await handler(command())
    assert (result.status, result.code) == (ResultStatus.FAILED, CLEANUP_FAILED)
    assert "segredo-interno" not in result.detail
    assert transport.sent == []


async def test_a_report_that_cannot_be_sent_is_a_failure_not_a_crash() -> None:
    class Down(FakeTransport):
        async def send(self, message: dict[str, object]) -> None:
            raise TransportError("fora do ar")

    clock = FakeClock()
    handler = tv_cleanup_handler(
        TvCleanup(tv(), clock), Down(), EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    )
    result = await handler(command())
    assert (result.status, result.code) == (ResultStatus.FAILED, "send_failed")


# --- registro -----------------------------------------------------------------------------------


async def test_the_info_log_has_only_counts_and_megabytes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adb = tv()
    with caplog.at_level(logging.INFO):
        await TvCleanup(adb, FakeClock()).run()
    info = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert info == ["limpeza da TV: 4 apps fechados, memória 300 -> 700 MB, 0 etapas falharam"]
    assert not any(package in caplog.text for package in (CINEVS, SPOTIFY, YOUTUBE, PLAY_STORE))


async def test_steps_that_failed_are_logged_as_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    adb = tv()
    adb.cleanup_errors[f"force-stop:{SPOTIFY}"] = AdbCommandFailed("a TV não fechou o app")
    with caplog.at_level(logging.INFO):
        await TvCleanup(adb, FakeClock()).run()
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings == [f"etapas da limpeza que falharam: force-stop:{SPOTIFY}"]


# --- a lista protegida está documentada ----------------------------------------------------------


def test_the_readme_documents_every_protected_package() -> None:
    readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    for package in sorted(PROTECTED_PACKAGES):
        assert f"`{package}`" in readme, package
    assert "com.android.providers." in readme
    assert "UNIOVER_TV_CLEANUP_KEEP" in readme
