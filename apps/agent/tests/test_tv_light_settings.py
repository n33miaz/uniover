import asyncio
import json
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvAdb
from uniover_agent.core.tv.light_settings import TvLightSettings, can_restrict_background
from uniover_agent.ports import AdbError

VIDEO = "com.example.video"
ANIMATIONS = ("window_animation_scale", "transition_animation_scale", "animator_duration_scale")


def make(adb: FakeTvAdb, state_path: Path | None = None, **extra: object) -> TvLightSettings:
    return TvLightSettings(
        adb,
        FakeClock(),
        lambda _: None,
        state_path=state_path,
        **extra,  # type: ignore[arg-type]
    )


async def test_short_animations_restore_the_exact_values_read_before_changing() -> None:
    adb = FakeTvAdb()
    adb.global_values["window_animation_scale"] = "1.25"
    adb.global_values["transition_animation_scale"] = "0"
    adb.global_values["animator_duration_scale"] = "1.0"
    settings = make(adb)

    await settings.configure(False, True, [])
    assert set(adb.global_values.values()) == {"0.5"}

    await settings.configure(False, False, [])
    assert adb.global_values == {
        "window_animation_scale": "1.25",
        "transition_animation_scale": "0",
        "animator_duration_scale": "1.0",
    }


async def test_a_setting_that_did_not_exist_is_deleted_again_instead_of_given_a_value() -> None:
    adb = FakeTvAdb()
    adb.global_values["animator_duration_scale"] = None
    settings = make(adb)

    await settings.configure(False, True, [])
    await settings.configure(False, False, [])

    assert "global-restore:animator_duration_scale:None" in adb.cleanup_log
    assert adb.global_values["animator_duration_scale"] is None


async def test_original_values_are_saved_before_a_change_and_survive_a_new_controller(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "light-settings.json"
    adb = FakeTvAdb()
    adb.global_values["window_animation_scale"] = "1.25"
    settings = make(adb, state_path)

    await settings.configure(False, True, [])
    assert (
        json.loads(state_path.read_text(encoding="utf-8"))["animations"]["window_animation_scale"]
        == "1.25"
    )
    restored = make(adb, state_path)
    await restored.configure(False, False, [])

    assert adb.global_values["window_animation_scale"] == "1.25"
    assert not state_path.exists()
    assert not state_path.with_name(state_path.name + ".tmp").exists()


async def test_the_tv_is_not_touched_when_the_originals_cannot_be_saved(tmp_path: Path) -> None:
    blocked = tmp_path / "arquivo"
    blocked.write_text("x", encoding="utf-8")
    adb = FakeTvAdb()
    settings = make(adb, blocked / "dentro" / "estado.json")

    await settings.configure(False, True, [VIDEO])

    assert adb.global_values["window_animation_scale"] == "1.0"
    assert not any(step.startswith(("global-put", "appops-set")) for step in adb.cleanup_log)
    assert settings._animations_original == {}
    assert settings._background_original == {}


async def test_every_original_is_saved_before_the_first_change(tmp_path: Path) -> None:
    state_path = tmp_path / "estado.json"
    adb = FakeTvAdb()
    snapshots: list[dict[str, object]] = []
    original_put = adb.put_global_setting

    async def spying_put(name: str, value: str) -> None:
        snapshots.append(json.loads(state_path.read_text(encoding="utf-8")))
        await original_put(name, value)

    adb.put_global_setting = spying_put  # type: ignore[method-assign]
    settings = make(adb, state_path)

    await settings.configure(False, True, [VIDEO])

    assert set(snapshots[0]["animations"]) == set(ANIMATIONS)  # type: ignore[call-overload]
    assert VIDEO in snapshots[0]["background"]  # type: ignore[operator]


async def test_a_failure_in_the_middle_rolls_back_what_was_already_changed(tmp_path: Path) -> None:
    state_path = tmp_path / "estado.json"
    adb = FakeTvAdb()
    adb.global_values["window_animation_scale"] = "1.25"
    adb.cleanup_errors[f"appops-set:{VIDEO}:ignore"] = AdbError("recusou")
    settings = make(adb, state_path)

    await settings.configure(False, True, [VIDEO])

    assert adb.global_values["window_animation_scale"] == "1.25"
    assert adb.global_values["transition_animation_scale"] == "1.0"
    assert adb.background_modes.get(VIDEO) is None
    assert settings._animations_original == {}
    assert settings._background_original == {}
    assert not state_path.exists()


async def test_background_restriction_restores_default_when_the_app_had_no_explicit_mode() -> None:
    adb = FakeTvAdb()
    settings = make(adb)

    await settings.configure(False, False, [VIDEO])
    assert adb.background_modes[VIDEO] == "ignore"

    await settings.configure(False, False, [])
    assert adb.background_modes[VIDEO] is None
    assert f"appops-set:{VIDEO}:default" in adb.cleanup_log


async def test_background_restriction_restores_the_explicit_mode_read_before_changing() -> None:
    adb = FakeTvAdb()
    adb.background_modes[VIDEO] = "allow"
    settings = make(adb)

    await settings.configure(False, False, [VIDEO])
    await settings.configure(False, False, [])

    assert adb.background_modes[VIDEO] == "allow"


async def test_an_app_that_became_protected_is_dropped_and_restored_on_the_next_round() -> None:
    adb = FakeTvAdb()
    adb.background_modes[VIDEO] = "allow"
    settings = make(adb)
    await settings.configure(False, False, [VIDEO, "com.example.outro"])
    assert adb.background_modes[VIDEO] == "ignore"

    # Passou a ser a tela inicial (ou o teclado): sai da lista e volta ao que era.
    adb.home = frozenset({VIDEO})
    await settings.configure(False, False, [VIDEO, "com.example.outro"])

    assert adb.background_modes[VIDEO] == "allow"
    assert adb.background_modes["com.example.outro"] == "ignore"
    assert VIDEO not in settings._background_original


@pytest.mark.parametrize("protection", ["home", "keyboard", "accessibility"])
async def test_a_dynamically_protected_app_is_never_restricted(protection: str) -> None:
    adb = FakeTvAdb()
    if protection == "home":
        adb.home = frozenset({VIDEO})
    elif protection == "keyboard":
        adb.keyboard = VIDEO
    else:
        adb.accessibility = frozenset({VIDEO})
    settings = make(adb)

    await settings.configure(False, False, [VIDEO])

    assert not any(step.startswith("appops-set") for step in adb.cleanup_log)


async def test_without_the_protections_no_new_app_is_restricted_but_existing_ones_stay() -> None:
    adb = FakeTvAdb()
    settings = make(adb)
    await settings.configure(False, False, [VIDEO])

    adb.cleanup_errors["home-packages"] = AdbError("sem resposta")
    await settings.configure(False, False, [VIDEO, "com.example.outro"])

    assert adb.background_modes[VIDEO] == "ignore"
    assert "com.example.outro" not in adb.background_modes


async def test_disabled_settings_touch_nothing_on_the_tv() -> None:
    adb = FakeTvAdb()
    settings = make(adb)

    await settings.configure(False, False, [])

    assert adb.cleanup_log == []


async def test_focus_enters_for_playback_and_leaves_after_the_grace_period() -> None:
    adb = FakeTvAdb()
    clock = FakeClock()
    holds: list[bool] = []
    settings = TvLightSettings(adb, clock, holds.append, lambda: "com.netflix.ninja")
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.netflix.ninja"})

    await settings._check_focus()
    assert settings.focus_active is True
    assert holds == [True]

    adb.media_owners = frozenset()
    clock.advance(181)
    await settings._check_focus()
    assert settings.focus_active is False
    assert holds == [True, False]


async def test_entering_focus_wakes_the_session_once_without_a_key() -> None:
    adb = FakeTvAdb()
    woken: list[str] = []

    async def wake() -> None:
        woken.append("wake")

    settings = TvLightSettings(
        adb, FakeClock(), lambda _: None, lambda: "com.netflix.ninja", wake=wake
    )
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.netflix.ninja"})

    await settings._check_focus()
    await settings._check_focus()

    assert woken == ["wake"]


async def test_a_session_that_does_not_wake_does_not_break_the_focus() -> None:
    adb = FakeTvAdb()

    async def wake() -> None:
        raise RuntimeError("TV desligada")

    settings = TvLightSettings(
        adb, FakeClock(), lambda _: None, lambda: "com.netflix.ninja", wake=wake
    )
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.netflix.ninja"})

    await settings._check_focus()

    assert settings.focus_active is True


@pytest.mark.parametrize(
    "package",
    [
        "android",
        "com.android.systemui",
        "com.android.vending",
        "com.google.android.tv.remote.service",
        "com.google.android.tvlauncher",
        "com.google.android.inputmethod.latin",
        "com.google.android.marvin.talkback",
        "com.android.providers.media",
        "com.tcl.launcher",
        "com.exemplo.remote_control",
    ],
)
async def test_background_restriction_never_touches_protected_packages(package: str) -> None:
    adb = FakeTvAdb()
    settings = make(adb)

    await settings.configure(False, False, [package])

    assert adb.cleanup_log == []
    assert can_restrict_background(package) is False


async def test_the_release_callbacks_run_when_focus_ends() -> None:
    adb = FakeTvAdb()
    clock = FakeClock()
    released: list[str] = []
    settings = TvLightSettings(adb, clock, lambda _: None, lambda: "com.netflix.ninja")
    settings.on_release(lambda: released.append("ok"))
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.netflix.ninja"})
    await settings._check_focus()
    assert released == []

    await settings.configure(False, False, [])
    assert settings.focus_active is False
    assert released == ["ok"]


async def test_focus_does_not_start_without_video_in_front() -> None:
    adb = FakeTvAdb()
    settings = TvLightSettings(adb, FakeClock(), lambda _: None, lambda: "com.exemplo.musica")
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.exemplo.musica"})

    await settings._check_focus()

    assert settings.focus_active is False


async def test_an_app_that_cannot_be_restored_does_not_block_the_others() -> None:
    adb = FakeTvAdb()
    settings = make(adb)
    await settings.configure(False, False, ["com.exemplo.a", "com.exemplo.b"])

    adb.cleanup_errors["appops-set:com.exemplo.a:default"] = AdbError("sumiu")
    await settings.configure(False, False, [])

    assert adb.background_modes["com.exemplo.b"] is None
    assert "com.exemplo.a" in settings._background_original


async def test_a_tv_error_while_reading_is_swallowed_and_changes_nothing() -> None:
    adb = FakeTvAdb()
    adb.cleanup_errors["global-get:window_animation_scale"] = AdbError("sem resposta")
    settings = make(adb)

    await settings.configure(False, True, [VIDEO])

    assert not any(step.startswith(("global-put", "appops-set")) for step in adb.cleanup_log)


@pytest.mark.parametrize("content", ["não é json", "[]", '{"animations": [], "background": {}}'])
def test_a_damaged_state_file_starts_clean(tmp_path: Path, content: str) -> None:
    state_path = tmp_path / "estado.json"
    state_path.write_text(content, encoding="utf-8")

    settings = make(FakeTvAdb(), state_path)

    assert settings._animations_original == {}
    assert settings._background_original == {}


def test_only_known_settings_and_text_values_come_back_from_the_state_file(tmp_path: Path) -> None:
    state_path = tmp_path / "estado.json"
    state_path.write_text(
        json.dumps(
            {
                "animations": {"window_animation_scale": "1.25", "qualquer": "9", "x": 3},
                "background": {"com.exemplo.video": "allow", "com.exemplo.b": None, "c": 1},
            }
        ),
        encoding="utf-8",
    )

    settings = make(FakeTvAdb(), state_path)

    assert settings._animations_original == {"window_animation_scale": "1.25"}
    assert settings._background_original == {"com.exemplo.video": "allow", "com.exemplo.b": None}


async def test_a_state_that_cannot_be_updated_after_restoring_does_not_stop_the_restore(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "estado.json"
    adb = FakeTvAdb()
    settings = make(adb, state_path)
    await settings.configure(False, True, [])
    state_path.unlink()
    state_path.mkdir()  # `unlink` do arquivo falha: é uma pasta

    await settings.configure(False, False, [])

    assert adb.global_values["window_animation_scale"] == "1.0"


async def test_a_tv_that_cannot_say_if_media_plays_ends_the_focus() -> None:
    adb = FakeTvAdb()
    holds: list[bool] = []
    settings = TvLightSettings(adb, FakeClock(), holds.append, lambda: "com.netflix.ninja")
    settings._focus_enabled = True
    adb.media_owners = frozenset({"com.netflix.ninja"})
    await settings._check_focus()

    adb.cleanup_errors["media"] = AdbError("ambígua")
    await settings._check_focus()

    assert holds == [True, False]


async def test_the_focus_loop_polls_while_enabled_and_releases_on_close() -> None:
    adb = FakeTvAdb()
    holds: list[bool] = []
    settings = TvLightSettings(adb, FakeClock(), holds.append, lambda: "com.netflix.ninja")
    adb.media_owners = frozenset({"com.netflix.ninja"})
    task = asyncio.create_task(settings.run())

    await settings.configure(True, False, [])
    for _ in range(20):
        await asyncio.sleep(0)
    assert settings.focus_active is True

    await settings.aclose()
    await asyncio.wait_for(task, timeout=5)
    assert holds == [True, False]


async def test_an_animation_that_cannot_be_restored_stays_recorded_for_the_next_round() -> None:
    adb = FakeTvAdb()
    adb.global_values["window_animation_scale"] = "1.25"
    settings = make(adb)
    await settings.configure(False, True, [])

    adb.cleanup_errors["global-restore:window_animation_scale:1.25"] = AdbError("sem resposta")
    await settings.configure(False, False, [])
    assert settings._animations_original == {"window_animation_scale": "1.25"}

    del adb.cleanup_errors["global-restore:window_animation_scale:1.25"]
    await settings.configure(False, False, [])
    assert adb.global_values["window_animation_scale"] == "1.25"
    assert settings._animations_original == {}
