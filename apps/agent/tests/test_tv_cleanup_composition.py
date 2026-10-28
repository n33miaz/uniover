"""Limpeza da TV na composição: handler registrado, lista do dono, e a conversa ponta a ponta."""

import asyncio
from pathlib import Path

import pytest
from websockets.asyncio.server import ServerConnection

from uniover_agent.adapters.fakes import FakeSecretStore, FakeTvAdb, FakeTvRemote
from uniover_agent.config import ConfigError, Settings, require_cleanup_keep
from uniover_agent.core import Command
from uniover_agent.main import EXIT_CREDENTIAL_REJECTED, run
from uniover_agent.ports import LaunchableApp

from .support import AGENT_ID, TOKEN, FakeApi, dump, envelope
from .test_tv_adb_composition import enable_adb
from .test_tv_composition import TV_HOST, make_tv, pair_fake_tv

REQUEST_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"
COMMAND_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f"
CONFIG_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e90"
CONFIG_ALLOWING = {
    "lightEnabled": True,
    "deepEnabled": False,
    "deepThresholdMb": 160,
    "closeBackgroundApps": True,
}


def running_tv() -> FakeTvAdb:
    adb = FakeTvAdb(
        [
            LaunchableApp("com.cnvs.apptv", ".ui.LoginActivity", user_installed=True),
            LaunchableApp("com.spotify.tv.android", ".Main", user_installed=True),
            LaunchableApp("com.android.vending", ".Main"),
        ]
    )
    adb.running = frozenset({"com.cnvs.apptv", "com.spotify.tv.android", "com.android.vending"})
    return adb


# --- configuração ---------------------------------------------------------------------------------


def test_the_keep_list_is_empty_by_default() -> None:
    assert Settings().tv_cleanup_keep == []
    assert require_cleanup_keep(Settings()) == frozenset()


def test_the_keep_list_reads_a_comma_separated_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UNIOVER_TV_CLEANUP_KEEP", " com.exemplo.um ,com.exemplo.dois,, ")
    settings = Settings()
    assert settings.tv_cleanup_keep == ["com.exemplo.um", "com.exemplo.dois"]
    assert require_cleanup_keep(settings) == {"com.exemplo.um", "com.exemplo.dois"}


@pytest.mark.parametrize(
    "line",
    [
        'tv_cleanup_keep = ["com.exemplo.um", "com.exemplo.dois"]',
        'tv_cleanup_keep = "com.exemplo.um,com.exemplo.dois"',
    ],
)
def test_the_keep_list_reads_the_config_file_as_a_list_or_as_text(
    isolated_env: Path, line: str
) -> None:
    isolated_env.write_text(line + "\n", encoding="utf-8")
    assert require_cleanup_keep(Settings()) == {"com.exemplo.um", "com.exemplo.dois"}


@pytest.mark.parametrize(
    "value", ["com.x;reboot", "semponto", "com.exemplo.um com.exemplo.dois", "$(id).x.y", "../x.y"]
)
def test_a_keep_entry_that_is_not_a_package_name_is_a_config_error(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("UNIOVER_TV_CLEANUP_KEEP", f"com.exemplo.ok,{value}")
    with pytest.raises(ConfigError, match="UNIOVER_TV_CLEANUP_KEEP"):
        require_cleanup_keep(Settings())


def test_a_bad_keep_list_stops_the_composition_even_when_the_adb_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    with pytest.raises(ConfigError):
        make_tv(Settings(tv_host=TV_HOST, tv_cleanup_keep=["lixo"]))


# --- composição -------------------------------------------------------------------------------


def test_the_cleanup_is_a_background_command_registered_only_with_the_adb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pair_fake_tv(monkeypatch, FakeTvRemote())
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert "tv.cleanup.v1" not in setup.handlers
    assert setup.background_commands == set()

    enable_adb(monkeypatch, tmp_path, running_tv())
    with_adb = make_tv(Settings(tv_host=TV_HOST))
    assert with_adb is not None
    assert "tv.cleanup.v1" in with_adb.handlers
    assert with_adb.background_commands == {"tv.cleanup.v1"}


async def test_the_owner_keep_list_reaches_the_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    adb = running_tv()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST, tv_cleanup_keep=["com.spotify.tv.android"]))
    assert setup is not None
    # O fechamento de apps só existe depois que a API liberou, para esta TV, pelo canal de
    # configuração.
    await setup.handlers["tv.cleanup.config.v1"](
        Command(CONFIG_ID, "tv.cleanup.config.v1", CONFIG_ALLOWING)
    )
    result = await setup.handlers["tv.cleanup.v1"](
        Command(COMMAND_ID, "tv.cleanup.v1", {"requestId": REQUEST_ID})
    )
    assert result.status.value == "ok"
    assert [s for s in adb.cleanup_log if s.startswith("force-stop")] == [
        "force-stop:com.cnvs.apptv",
        "force-stop:com.android.vending",
    ]


async def test_by_default_the_composed_cleanup_never_stops_or_kills_an_app(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Regra do dono: sem a opção por TV, a limpeza (manual ou configurada) não fecha app nenhum."""
    adb = running_tv()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None

    async def clean() -> None:
        result = await setup.handlers["tv.cleanup.v1"](
            Command(COMMAND_ID, "tv.cleanup.v1", {"requestId": REQUEST_ID})
        )
        assert result.status.value == "ok"

    await clean()
    await setup.handlers["tv.cleanup.config.v1"](
        Command(
            CONFIG_ID, "tv.cleanup.config.v1", {**CONFIG_ALLOWING, "closeBackgroundApps": False}
        )
    )
    await clean()

    assert not any(
        step in {"go-home", "kill-background"} or step.startswith("force-stop:")
        for step in adb.cleanup_log
    )


# --- ponta a ponta ----------------------------------------------------------------------------


async def test_run_answers_the_cleanup_with_the_report_first_and_the_result_after(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    adb = running_tv()
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)

    async def script(connection: ServerConnection) -> None:
        await connection.send(dump(envelope("tv.cleanup.config.v1", CONFIG_ALLOWING, id=CONFIG_ID)))
        await asyncio.sleep(0.3)
        await connection.send(
            dump(envelope("tv.cleanup.v1", {"requestId": REQUEST_ID}, id=COMMAND_ID))
        )
        # O agente pausa um pouco depois de HOME e antes da leitura final (relógio de verdade).
        await asyncio.sleep(2.6)
        await connection.close(4403, "revoked")

    store = FakeSecretStore()
    store.set(AGENT_ID, TOKEN)
    async with FakeApi(script) as api:
        settings = Settings(
            api_url=api.http_url, agent_id=AGENT_ID, allow_insecure=True, tv_host=TV_HOST
        )
        assert await run(settings, lambda: store) == EXIT_CREDENTIAL_REJECTED

    about_it = [m for m in api.received if m["correlationId"] == COMMAND_ID]
    assert [m["type"] for m in about_it] == ["tv.cleanup.result.v1", "command.result.v1"]
    report, result = about_it
    assert report["body"]["requestId"] == REQUEST_ID
    assert report["body"]["closedApps"] == 3
    assert (report["body"]["memoryBeforeMb"], report["body"]["memoryAfterMb"]) == (300, 700)
    assert result["body"] == {"ok": True}
    assert "go-home" in adb.cleanup_log


async def test_the_light_settings_from_the_config_are_applied_only_to_the_chosen_apps_and_undone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Regra do dono: só o que a pessoa ligou muda na TV, e desligar devolve o valor lido antes."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    adb = running_tv()
    adb.global_values["window_animation_scale"] = "1.25"
    pair_fake_tv(monkeypatch, FakeTvRemote())
    enable_adb(monkeypatch, tmp_path, adb)
    setup = make_tv(Settings(tv_host=TV_HOST))
    assert setup is not None
    assert setup.light_settings is not None

    # Sem os campos novos (API antiga) nada é tocado.
    await setup.handlers["tv.cleanup.config.v1"](
        Command(CONFIG_ID, "tv.cleanup.config.v1", CONFIG_ALLOWING)
    )
    assert not any(step.startswith(("global-", "appops-")) for step in adb.cleanup_log)

    await setup.handlers["tv.cleanup.config.v1"](
        Command(
            CONFIG_ID,
            "tv.cleanup.config.v1",
            {
                **CONFIG_ALLOWING,
                "shortAnimationsEnabled": True,
                "restrictedPackages": ["com.spotify.tv.android", "com.android.vending", 7],
            },
        )
    )
    assert adb.global_values["window_animation_scale"] == "0.5"
    assert [s for s in adb.cleanup_log if s.startswith("appops-set")] == [
        "appops-set:com.spotify.tv.android:ignore"
    ]

    await setup.handlers["tv.cleanup.config.v1"](
        Command(CONFIG_ID, "tv.cleanup.config.v1", CONFIG_ALLOWING)
    )
    assert adb.global_values["window_animation_scale"] == "1.25"
    assert adb.background_modes["com.spotify.tv.android"] is None
