"""Lista de apps da TV: nomes, filtro, ordem, publicação em `tv.apps.v1` e abertura por pacote."""

import asyncio
from typing import Any

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb, FakeTvRemote
from uniover_agent.adapters.tv_adb_parsing import parse_launchable
from uniover_agent.core import (
    AppsAnnouncer,
    Command,
    EnvelopeFactory,
    EnvelopeGate,
    ResultStatus,
    TvApps,
    TvSessionManager,
    TvState,
    describe_apps,
    tv_app_launch_handler,
    tv_apps_refresh_handler,
)
from uniover_agent.core.tv.apps import KNOWN_LABELS, is_user_app, label_for
from uniover_agent.ports import (
    AdbTimeout,
    AdbUnauthorized,
    LaunchableApp,
    TransportError,
    TvUnreachable,
)

from .support import AGENT_ID
from .support_adb import LEANBACK_SAMPLE

REQUEST_ID = "0192f1e4-0000-7000-8000-000000000001"

# --- nomes --------------------------------------------------------------------------------------


def test_known_apps_get_their_names() -> None:
    assert label_for("com.netflix.ninja") == "Netflix"
    assert label_for("com.google.android.youtube.tv") == "YouTube"
    assert label_for("com.android.tv.settings") == "Configurações"
    assert label_for("com.android.vending") == "Play Store"
    assert label_for("com.spotify.tv.android") == "Spotify"


def test_the_app_installed_by_apk_is_called_cinevs() -> None:
    assert label_for("com.cnvs.apptv") == "CineVS"


@pytest.mark.parametrize(
    ("package", "label"),
    [
        ("com.example.player", "Player"),
        ("com.foo.bar.tv", "Bar"),
        ("com.foo.meu_app_legal", "Meu App Legal"),
        ("org.exemplo.android", "Exemplo"),
        ("a.b", "B"),
    ],
)
def test_unknown_apps_get_a_name_derived_from_the_package(package: str, label: str) -> None:
    assert label_for(package) == label


def test_every_label_fits_the_contract() -> None:
    assert all(1 <= len(label) <= 100 for label in KNOWN_LABELS.values())
    assert 1 <= len(label_for("com." + "x" * 250)) <= 100


# --- filtro -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "package",
    [
        "com.cnvs.apptv",
        "com.spotify.tv.android",
        "com.google.android.youtube.tv",
        "com.android.vending",
        "com.android.tv.settings",
        "com.netflix.ninja",
    ],
)
def test_real_apps_are_kept(package: str) -> None:
    assert is_user_app(package)


@pytest.mark.parametrize(
    "package",
    [
        "com.tcl.suspension",
        "com.tcl.partnercustomizer",
        "com.tcl.settings",
        "com.tcl.initsetup",
        "com.android.tv.feedback",
        "com.google.android.tvrecommendations",
        "com.google.android.tungsten.setupwraith",
        "com.exemplo.factorytest",
    ],
)
def test_system_pieces_are_hidden(package: str) -> None:
    assert not is_user_app(package)


def test_the_apk_installed_app_is_never_removed_by_the_filter() -> None:
    names = [app.package for app in describe_apps(parse_launchable(LEANBACK_SAMPLE))]
    assert "com.cnvs.apptv" in names
    assert "com.tcl.suspension" not in names
    assert "com.tcl.partnercustomizer" not in names


# --- ordem --------------------------------------------------------------------------------------


def real_tv_apps() -> list[LaunchableApp]:
    user = {"com.spotify.tv.android", "com.cnvs.apptv"}
    return [
        LaunchableApp(app.package, app.activity, app.package in user)
        for app in parse_launchable(LEANBACK_SAMPLE)
    ]


def test_apps_installed_by_the_owner_come_before_the_ones_that_ship_with_the_tv() -> None:
    entries = describe_apps(real_tv_apps())
    assert [(e.label, e.user_installed) for e in entries] == [
        ("CineVS", True),
        ("Spotify", True),
        ("Configurações", False),
        ("Play Store", False),
        ("YouTube", False),
    ]


def test_each_group_is_sorted_by_name_without_regard_to_case() -> None:
    entries = describe_apps(
        [
            LaunchableApp("com.exemplo.zeta", ".A"),
            LaunchableApp("com.exemplo.Alfa", ".A"),
            LaunchableApp("com.exemplo.omega", ".A", user_installed=True),
            LaunchableApp("com.exemplo.Alfa", ".B"),
        ]
    )
    assert [e.package for e in entries] == [
        "com.exemplo.omega",
        "com.exemplo.Alfa",
        "com.exemplo.zeta",
    ]


def test_the_list_respects_the_contract_limit() -> None:
    many = [LaunchableApp(f"com.exemplo.app{chr(97 + i % 26)}{i}", ".A") for i in range(600)]
    assert len(describe_apps(many)) == 500


# --- publicação e handlers ----------------------------------------------------------------------


class Env:
    def __init__(self, adb: FakeTvAdb | None = None) -> None:
        self.clock = FakeClock()
        self.remote = FakeTvRemote()
        self.manager = TvSessionManager(self.clock, self.remote)
        self.adb = adb or FakeTvAdb(real_tv_apps())
        self.transport = FakeTransport()
        envelopes = EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), self.clock)
        self.apps = TvApps(self.manager, self.adb, self.transport, envelopes)
        self.refresh = tv_apps_refresh_handler(self.apps)
        self.launch = tv_app_launch_handler(self.manager, packages=self.apps)

    def apps_messages(self) -> list[dict[str, Any]]:
        return [m for m in self.transport.sent if m["type"] == "tv.apps.v1"]


async def test_refresh_lists_publishes_tv_apps_and_answers_the_request() -> None:
    env = Env()
    command = Command(REQUEST_ID, "tv.apps.refresh.v1", {})
    result = await env.refresh(command)
    assert result.status is ResultStatus.OK
    (message,) = env.apps_messages()
    assert message["target"] == "api"
    assert message["correlationId"] == command.id
    assert message["body"]["apps"] == [
        {"package": "com.cnvs.apptv", "label": "CineVS"},
        {"package": "com.spotify.tv.android", "label": "Spotify"},
        {"package": "com.android.tv.settings", "label": "Configurações"},
        {"package": "com.android.vending", "label": "Play Store"},
        {"package": "com.google.android.youtube.tv", "label": "YouTube"},
    ]
    assert message["body"]["at"].endswith("Z")
    # O pedido mantém a sessão quente.
    assert env.remote.connects == 1


@pytest.mark.parametrize(
    ("error", "code"),
    [(AdbUnauthorized("x"), "adb_unauthorized"), (AdbTimeout("x"), "adb_timeout")],
)
async def test_refresh_errors_become_a_result_with_a_clear_code(error: Any, code: str) -> None:
    env = Env()
    env.adb.errors = [error]
    result = await env.refresh(Command(REQUEST_ID, "tv.apps.refresh.v1", {}))
    assert (result.status, result.code) == (ResultStatus.FAILED, code)
    assert env.apps_messages() == []
    assert env.apps.cache is None


async def test_refresh_reports_when_the_api_cannot_be_reached() -> None:
    env = Env()

    async def failing(message: dict[str, Any]) -> None:
        raise TransportError("canal fechado")

    env.transport.send = failing  # type: ignore[method-assign]
    result = await env.refresh(Command(REQUEST_ID, "tv.apps.refresh.v1", {}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "send_failed")


async def test_refresh_works_when_the_remote_service_is_down_because_the_adb_is_independent() -> (
    None
):
    env = Env()
    env.remote.connect_errors = [TvUnreachable("x") for _ in range(8)]
    result = await env.refresh(Command(REQUEST_ID, "tv.apps.refresh.v1", {}))
    assert result.status is ResultStatus.OK
    assert len(env.apps_messages()) == 1


async def test_launching_by_package_goes_through_the_adb() -> None:
    env = Env()
    target = {"kind": "package", "value": "com.cnvs.apptv"}
    result = await env.launch(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.OK
    assert env.adb.launched == [("com.cnvs.apptv", None)]
    assert env.remote.links == []


async def test_launching_a_link_still_goes_through_the_remote() -> None:
    env = Env()
    target = {"kind": "link", "value": "https://www.youtube.com/watch?v=abc"}
    result = await env.launch(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.OK
    assert env.remote.links == ["https://www.youtube.com/watch?v=abc"]
    assert env.adb.launched == []


async def test_launch_errors_become_codes_and_never_leak_details() -> None:
    env = Env()
    env.adb.errors = [AdbUnauthorized("a TV ainda não autorizou este PC no ADB")]
    target = {"kind": "package", "value": "com.cnvs.apptv"}
    result = await env.launch(Command("1", "tv.app.launch.v1", {"target": target}))
    assert (result.status, result.code) == (ResultStatus.FAILED, "adb_unauthorized")
    assert "\\" not in result.detail


async def test_a_package_the_adb_refuses_is_rejected() -> None:
    class Strict(FakeTvAdb):
        async def launch_package(self, package: str, activity: str | None = None) -> None:
            raise ValueError("nome de pacote inválido")

    env = Env(Strict())
    target = {"kind": "package", "value": "com.x"}
    result = await env.launch(Command("1", "tv.app.launch.v1", {"target": target}))
    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_target")


@pytest.mark.parametrize("value", [None, "", 5])
async def test_package_launch_without_a_value_is_rejected(value: object) -> None:
    env = Env()
    target = {"kind": "package", "value": value}
    result = await env.launch(Command("1", "tv.app.launch.v1", {"target": target}))
    assert result.status is ResultStatus.REJECTED
    assert env.adb.launched == []


# --- aviso da lista depois do hello -------------------------------------------------------------


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


def hot(connection: str = "hot") -> TvState:
    return TvState("on", None, None, connection)  # type: ignore[arg-type]


async def test_the_list_is_published_once_when_the_session_gets_hot_after_the_hello() -> None:
    env = Env()
    announcer = AppsAnnouncer(env.apps, lambda: env.manager.snapshot().connection == "hot")
    task = asyncio.create_task(announcer.run())
    await announcer.after_hello()
    await settle()
    # Sessão dormindo: nada a perguntar à TV ainda (ela tem pouca memória).
    assert env.apps_messages() == []
    await env.manager.wake()
    announcer.on_state(hot())
    await settle()
    assert len(env.apps_messages()) == 1
    # Novos "quente" na mesma conexão não repetem.
    announcer.on_state(hot())
    await settle()
    assert len(env.apps_messages()) == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_new_connection_resends_the_cached_list_without_touching_the_tv() -> None:
    env = Env()
    await env.apps.refresh()
    env.adb.apps = []  # se perguntasse de novo, viria vazio
    announcer = AppsAnnouncer(env.apps, lambda: False)
    task = asyncio.create_task(announcer.run())
    await announcer.after_hello()
    await settle()
    (message,) = env.apps_messages()
    assert len(message["body"]["apps"]) == 5
    await announcer.after_hello()
    await settle()
    assert len(env.apps_messages()) == 2
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_an_adb_error_in_the_announcement_never_stops_the_announcer() -> None:
    env = Env()
    env.adb.errors = [AdbUnauthorized("x")]
    announcer = AppsAnnouncer(env.apps, lambda: True)
    task = asyncio.create_task(announcer.run())
    await announcer.after_hello()
    await settle()
    assert env.apps_messages() == []
    assert not task.done()
    announcer.on_state(hot())
    await settle()
    assert len(env.apps_messages()) == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_the_announcer_survives_an_unexpected_error() -> None:
    class Broken(FakeTvAdb):
        async def list_apps(self) -> list[LaunchableApp]:
            raise RuntimeError("inesperado")

    env = Env(Broken())
    announcer = AppsAnnouncer(env.apps, lambda: True)
    task = asyncio.create_task(announcer.run())
    await announcer.after_hello()
    await settle()
    assert not task.done()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_the_announcement_is_deferred_during_focus_and_made_when_it_ends() -> None:
    env = Env()
    paused = [True]
    announcer = AppsAnnouncer(env.apps, lambda: True, is_paused=lambda: paused[0])
    task = asyncio.create_task(announcer.run())
    await announcer.after_hello()
    await settle()
    assert env.apps_messages() == []

    paused[0] = False
    announcer.resume()
    await settle()
    assert len(env.apps_messages()) == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
