"""TV Livre (núcleo): a ordem segura dos passos, com uma TV Android simulada.

O que importa aqui é a SEQUÊNCIA: o original é capturado e ensaiado antes de instalar, a home nova
só vale depois de verificada, o launcher de fábrica só é desativado depois disso, e nada é
desinstalado sem a volta confirmada. Cada falha injetada tem de terminar sem tela preta.
"""

import base64
import hashlib
import json
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core.tv.livre import (
    FILES_DIR,
    HOME_COMPONENT,
    PACKAGE,
    LivreError,
    LivreStateFile,
    PhotoStaging,
    TvLivre,
    is_protected_for_disable,
)
from uniover_agent.ports.tv_livre import LauncherApkError

from .support_livre import (
    BLOAT,
    FACTORY,
    FACTORY_PACKAGE,
    IME,
    NETFLIX,
    YOUTUBE,
    FakeAndroid,
    FakeApkSource,
    jpeg_bytes,
    noisy_jpeg,
)

CONFIG = json.dumps({"clock": {"size": "large"}, "apps": {"mode": "listed", "items": [NETFLIX]}})


def make(
    tmp_path: Path, android: FakeAndroid | None = None, error: LauncherApkError | None = None
) -> tuple[TvLivre, FakeAndroid, LivreStateFile, FakeApkSource]:
    android = android or FakeAndroid()
    state = LivreStateFile(tmp_path / "state" / "tv-livre.json")
    apk = FakeApkSource(tmp_path, error)
    livre = TvLivre(android, apk, state, PhotoStaging(FakeClock()), FakeClock())
    return livre, android, state, apk


async def expect_error(livre: TvLivre, body: dict, code: str) -> LivreError:
    with pytest.raises(LivreError) as raised:
        await livre.run(body)
    assert raised.value.code == code
    return raised.value


# --- suporte ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "android", [FakeAndroid(sdk=26), FakeAndroid(leanback=False)], ids=["android-8", "sem-leanback"]
)
async def test_unsupported_tv_reports_it_and_refuses_every_action(
    tmp_path: Path, android: FakeAndroid
) -> None:
    livre, android, _, apk = make(tmp_path, android)

    state = await livre.read_state()
    assert state.supported is False
    assert state.apps == ()

    for action in ("install", "set-home", "restore", "apply", "set-apps", "sleep"):
        error = await expect_error(livre, {"action": action}, "unsupported")
        assert error.rejected is True
    assert android.mutating() == []
    assert apk.fetches == 0


async def test_status_reads_state_and_changes_nothing(tmp_path: Path) -> None:
    livre, android, _, _ = make(tmp_path)

    await livre.run({"action": "status"})
    state = await livre.read_state()

    assert (state.supported, state.installed, state.is_home) == (True, False, False)
    assert {app.package for app in state.apps} == {
        YOUTUBE,
        NETFLIX,
        BLOAT,
        "com.android.tv.settings",
    }
    by_package = {app.package: app for app in state.apps}
    # Atualizado pelo dono (APK em /data) não é "de fábrica"; o que ficou na partição do sistema é.
    assert by_package[YOUTUBE].factory is False
    assert by_package[BLOAT].factory is True
    assert android.mutating() == []


# --- instalar --------------------------------------------------------------------------------


async def test_install_captures_and_rehearses_the_factory_launcher_before_installing(
    tmp_path: Path,
) -> None:
    livre, android, state, _ = make(tmp_path)

    await livre.run({"action": "install"})

    rehearsal = android.index(f"cmd package set-home-activity {FACTORY}")
    install = android.index("install")
    opened = android.index(f"am start -n {HOME_COMPONENT}")
    assert rehearsal < install < opened
    # O original ficou em disco, para a volta sobreviver a uma queda do agente.
    assert state.load()["factory"] == FACTORY
    # Instalar não torna a home nova o padrão.
    assert android.home == FACTORY
    assert (await livre.read_state()).installed is True
    assert (await livre.read_state()).is_home is False


async def test_install_without_a_launcher_that_passes_the_rehearsal_changes_nothing(
    tmp_path: Path,
) -> None:
    android = FakeAndroid(reject_set_home=frozenset({FACTORY}))
    livre, android, _, apk = make(tmp_path, android)

    await expect_error(livre, {"action": "install"}, "no_factory_launcher")

    assert android.installed is False
    assert apk.fetches == 0


async def test_install_tries_the_next_home_handler_when_the_first_fails_the_rehearsal(
    tmp_path: Path,
) -> None:
    other = "com.tcl.launcher/.Main"
    android = FakeAndroid(homes=(FACTORY, other), reject_set_home=frozenset({FACTORY}))
    livre, android, state, _ = make(tmp_path, android)

    await livre.run({"action": "install"})

    assert state.load()["factory"] == other


async def test_install_with_a_bad_download_installs_nothing(tmp_path: Path) -> None:
    error = LauncherApkError("apk_hash_mismatch", "não confere")
    livre, android, _, _ = make(tmp_path, error=error)

    with pytest.raises(LauncherApkError) as raised:
        await livre.run({"action": "install"})

    assert raised.value.code == "apk_hash_mismatch"
    assert android.installed is False


async def test_install_over_another_signature_has_a_stable_code(tmp_path: Path) -> None:
    android = FakeAndroid()
    android.fail.add("mismatch")
    livre, android, _, _ = make(tmp_path, android)

    await expect_error(livre, {"action": "install"}, "signature_mismatch")


async def test_install_failure_has_a_stable_code(tmp_path: Path) -> None:
    android = FakeAndroid()
    android.fail.add("install")
    livre, android, _, _ = make(tmp_path, android)

    await expect_error(livre, {"action": "install"}, "install_failed")


# --- aplicar a configuração ------------------------------------------------------------------


async def installed(tmp_path: Path, android: FakeAndroid | None = None):
    livre, android, state, apk = make(tmp_path, android)
    await livre.run({"action": "install"})
    android.log.clear()
    return livre, android, state, apk


async def test_apply_pushes_a_temporary_file_then_renames_it(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)

    await livre.run({"action": "apply", "revision": 7, "configJson": CONFIG})

    tmp_push = android.index(f"push {FILES_DIR}/config.json.tmp")
    rename = android.index(f"mv -f {FILES_DIR}/config.json.tmp {FILES_DIR}/config.json")
    assert tmp_push < rename
    written = json.loads(android.files[f"{FILES_DIR}/config.json"])
    assert written["schema"] == 1
    assert written["revision"] == 7
    assert written["apps"] == {"mode": "listed", "items": [NETFLIX]}
    # A pré-visualização: o app é aberto para redesenhar com a configuração nova.
    assert f"am start -n {HOME_COMPONENT}" in android.log[-2:]


async def test_apply_rejects_an_invalid_config_before_touching_the_tv(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)

    bad = json.dumps({"apps": {"items": ["rm -rf /"]}})
    await expect_error(
        livre, {"action": "apply", "revision": 1, "configJson": bad}, "invalid_config"
    )
    await expect_error(
        livre, {"action": "apply", "revision": 1, "configJson": "{"}, "invalid_config"
    )

    assert android.mutating() == []


async def test_apply_requires_the_launcher_to_be_installed(tmp_path: Path) -> None:
    livre, android, _, _ = make(tmp_path)

    await expect_error(
        livre, {"action": "apply", "revision": 1, "configJson": CONFIG}, "not_installed"
    )

    assert android.mutating() == []


async def test_apply_sends_the_staged_photo_before_the_config(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    photo = jpeg_bytes()
    stage(livre, "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1", photo)
    config = json.dumps({"wallpaper": {"type": "photo", "colors": ["#112233"]}})

    await livre.run(
        {
            "action": "apply",
            "revision": 2,
            "configJson": config,
            "photoId": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1",
        }
    )

    assert android.index(f"push {FILES_DIR}/wallpaper.jpg.tmp") < android.index(
        f"push {FILES_DIR}/config.json.tmp"
    )
    assert android.files[f"{FILES_DIR}/wallpaper.jpg"] == photo
    assert (
        json.loads(android.files[f"{FILES_DIR}/config.json"])["wallpaper"]["photo"]
        == "wallpaper.jpg"
    )


async def test_apply_with_an_unknown_photo_id_asks_for_it_again(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)

    error = await expect_error(
        livre,
        {
            "action": "apply",
            "revision": 1,
            "configJson": CONFIG,
            "photoId": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1",
        },
        "photo_missing",
    )

    assert error.rejected is True
    assert android.mutating() == []


async def test_apply_falls_back_to_the_broadcast_when_the_app_folder_is_missing(
    tmp_path: Path,
) -> None:
    livre, android, _, _ = await installed(tmp_path)
    android.files_dir = False

    original = android.shell

    async def shell(command: str):
        result = await original(command)
        android.files_dir = False
        return result

    android.shell = shell  # type: ignore[method-assign]

    await livre.run({"action": "apply", "revision": 3, "configJson": CONFIG})

    assert any(
        c.startswith("am broadcast -n br.uniover.launcher/.ConfigReceiver") for c in android.log
    )
    assert not any(c.startswith("push") for c in android.log)


# --- definir como padrão ---------------------------------------------------------------------


async def test_set_home_verifies_before_anything_else_and_keeps_the_factory_launcher(
    tmp_path: Path,
) -> None:
    livre, android, _, _ = await installed(tmp_path)

    await livre.run({"action": "set-home"})

    assert android.home == HOME_COMPONENT
    assert not any(c.startswith("pm disable") for c in android.log)
    assert android.black_screen is False


async def test_set_home_retries_with_the_user_flag_when_the_system_asks_for_it(
    tmp_path: Path,
) -> None:
    livre, android, _, _ = await installed(tmp_path, FakeAndroid(needs_user_flag=True))

    await livre.run({"action": "set-home"})

    assert android.home == HOME_COMPONENT
    assert f"cmd package set-home-activity --user 0 {HOME_COMPONENT}" in android.log


async def test_set_home_that_does_not_stick_goes_back_to_the_original(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    android.ours_resolves = False

    await expect_error(livre, {"action": "set-home", "disableFactory": True}, "verify_failed")

    # Sem verificação não se desativa nada, e a TV volta ao launcher de fábrica.
    assert not any(c.startswith("pm disable") for c in android.log)
    assert android.home == FACTORY
    assert f"am start -n {FACTORY}" in android.log
    assert android.black_screen is False


async def test_set_home_rejected_by_the_system_changes_nothing(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(
        tmp_path, FakeAndroid(reject_set_home=frozenset({HOME_COMPONENT}))
    )

    await expect_error(livre, {"action": "set-home"}, "set_home_failed")

    assert android.home == FACTORY


async def test_set_home_can_disable_the_factory_launcher_only_after_verifying(
    tmp_path: Path,
) -> None:
    livre, android, state, _ = await installed(tmp_path)

    await livre.run({"action": "set-home", "disableFactory": True})

    set_home = android.index(f"cmd package set-home-activity {HOME_COMPONENT}")
    verify = android.index("cmd package resolve-activity", set_home)
    disable = android.index(f"pm disable-user --user 0 {FACTORY_PACKAGE}")
    assert set_home < verify < disable
    assert state.load()["disabled"] == [FACTORY_PACKAGE]
    assert android.black_screen is False


async def test_a_failed_disable_leaves_the_factory_launcher_enabled(tmp_path: Path) -> None:
    livre, android, state, _ = await installed(tmp_path)
    android.fail.add("pm disable-user")

    await expect_error(livre, {"action": "set-home", "disableFactory": True}, "disable_failed")

    assert state.load()["disabled"] == []
    assert FACTORY_PACKAGE not in android.disabled


# --- voltar ao original ----------------------------------------------------------------------


async def test_restore_enables_sets_verifies_and_only_then_uninstalls(tmp_path: Path) -> None:
    livre, android, state, _ = await installed(tmp_path)
    await livre.run({"action": "set-home", "disableFactory": True})
    await livre.run({"action": "set-apps", "disable": [BLOAT]})
    android.log.clear()

    await livre.run({"action": "restore"})

    enable = android.index(f"pm enable --user 0 {FACTORY_PACKAGE}")
    set_home = android.index(f"cmd package set-home-activity {FACTORY}")
    verify = android.index("cmd package resolve-activity", set_home)
    uninstall = android.index(f"pm uninstall {PACKAGE}")
    assert enable < set_home < verify < uninstall
    assert android.home == FACTORY
    assert android.installed is False
    assert BLOAT not in android.disabled  # o que foi desativado pelo app volta
    assert android.black_screen is False
    assert state.load() == {}


async def test_restore_that_cannot_be_verified_uninstalls_nothing(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    await livre.run({"action": "set-home", "disableFactory": True})
    android.log.clear()
    android.reject_set_home = frozenset({FACTORY})

    await expect_error(livre, {"action": "restore"}, "verify_failed")

    assert not any(c.startswith("pm uninstall") for c in android.log)
    assert android.installed is True
    assert android.black_screen is False


async def test_restore_without_uninstalling_keeps_the_app(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    await livre.run({"action": "set-home"})

    await livre.run({"action": "restore", "uninstall": False})

    assert android.installed is True
    assert android.home == FACTORY


async def test_restore_without_the_stored_original_falls_back_to_the_other_handlers(
    tmp_path: Path,
) -> None:
    livre, android, state, _ = await installed(tmp_path)
    await livre.run({"action": "set-home"})
    state.delete()  # arquivo perdido

    await livre.run({"action": "restore"})

    assert android.home == FACTORY
    assert android.installed is False


# --- desativar e reativar apps ---------------------------------------------------------------


async def test_disable_records_the_package_before_disabling_and_enable_forgets_it(
    tmp_path: Path,
) -> None:
    livre, android, state, _ = await installed(tmp_path)

    await livre.run({"action": "set-apps", "disable": [BLOAT]})
    assert BLOAT in android.disabled
    assert state.load()["disabled"] == [BLOAT]
    assert (await livre.read_state()).disabled_packages == (BLOAT,)

    await livre.run({"action": "set-apps", "enable": [BLOAT]})
    assert BLOAT not in android.disabled
    assert state.load()["disabled"] == []


@pytest.mark.parametrize(
    "package",
    [
        PACKAGE,  # a nossa home
        FACTORY_PACKAGE,  # o launcher de fábrica (só sai pelo caminho verificado)
        IME,  # o teclado em uso
        "com.google.android.tv.remote.service",
        "com.android.tv.settings",
        "com.google.android.gms",
        "com.android.providers.media",
        "com.android.bluetooth",
        "com.example.remote.app",
    ],
)
async def test_protected_packages_are_never_disabled(tmp_path: Path, package: str) -> None:
    livre, android, _, _ = await installed(tmp_path)

    error = await expect_error(
        livre, {"action": "set-apps", "disable": [package]}, "protected_package"
    )

    assert error.rejected is True
    assert not any(c.startswith("pm disable") for c in android.log)


async def test_a_vendor_app_that_the_cleanup_would_keep_can_still_be_disabled(
    tmp_path: Path,
) -> None:
    # `is_protected` do fechamento de apps protege tudo que não é "app de uso": aqui não vale.
    assert is_protected_for_disable(BLOAT, frozenset()) is False
    assert is_protected_for_disable("com.tcl.suspension", frozenset()) is False


async def test_set_apps_rejects_an_invalid_package_name(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)

    await expect_error(livre, {"action": "set-apps", "disable": ["x; reboot"]}, "invalid_package")

    assert android.mutating() == []


async def test_a_failed_disable_is_forgotten(tmp_path: Path) -> None:
    livre, android, state, _ = await installed(tmp_path)
    android.fail.add("pm disable-user")

    await expect_error(livre, {"action": "set-apps", "disable": [BLOAT]}, "disable_failed")

    assert state.load()["disabled"] == []


# --- Modo Dormir -----------------------------------------------------------------------------


async def test_sleep_opens_the_sleep_activity(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)

    await livre.run({"action": "sleep"})

    assert android.log[-1] == f"am start -n {PACKAGE}/.SleepActivity"


async def test_sleep_requires_the_launcher(tmp_path: Path) -> None:
    livre, _, _, _ = make(tmp_path)

    await expect_error(livre, {"action": "sleep"}, "not_installed")


async def test_unknown_action_is_rejected(tmp_path: Path) -> None:
    livre, _, _, _ = make(tmp_path)

    await expect_error(livre, {"action": "format"}, "unknown_action")


# --- auditoria -------------------------------------------------------------------------------


async def test_audit_keeps_the_latest_entries_in_the_state_file(tmp_path: Path) -> None:
    livre, _, state, _ = make(tmp_path)

    for _ in range(60):
        livre.audit("status", "ok")
    livre.audit("restore", "verify_failed")

    audit = state.load()["audit"]
    assert len(audit) == 50
    assert audit[-1]["action"] == "restore"
    assert audit[-1]["result"] == "verify_failed"


# --- foto ------------------------------------------------------------------------------------


def stage(livre: TvLivre, photo_id: str, photo: bytes, chunk: int = 60) -> None:

    digest = hashlib.sha256(photo).hexdigest()
    parts = [photo[i : i + chunk] for i in range(0, len(photo), chunk)]
    for index, part in enumerate(parts):
        livre._photos.add(photo_id, index, len(parts), digest, base64.b64encode(part).decode())


async def test_photo_pieces_are_joined_in_any_order_and_checked(tmp_path: Path) -> None:

    clock = FakeClock()
    staging = PhotoStaging(clock)
    photo = jpeg_bytes(64, 48)
    digest = hashlib.sha256(photo).hexdigest()
    pieces = [photo[:100], photo[100:]]

    staging.add("p", 1, 2, digest, base64.b64encode(pieces[1]).decode())
    assert staging.take("p") is None
    staging.add("p", 0, 2, digest, base64.b64encode(pieces[0]).decode())

    assert staging.take("p") == photo
    assert staging.take("outra") is None
    clock.advance(601)
    assert staging.take("p") is None


@pytest.mark.parametrize(
    "mutate",
    ["hash", "not-jpeg", "base64", "too-big"],
)
async def test_a_bad_photo_is_refused(mutate: str) -> None:

    staging = PhotoStaging(FakeClock())
    photo = jpeg_bytes()
    digest = hashlib.sha256(photo).hexdigest()
    data = base64.b64encode(photo).decode()
    if mutate == "hash":
        digest = "0" * 64
    elif mutate == "not-jpeg":
        photo = b"GIF89a" + b"y" * 50
        digest = hashlib.sha256(photo).hexdigest()
        data = base64.b64encode(photo).decode()
    elif mutate == "base64":
        data = "@@@@"
    else:
        photo = noisy_jpeg()
        digest = hashlib.sha256(photo).hexdigest()
        data = base64.b64encode(photo).decode()

    with pytest.raises(LivreError) as raised:
        staging.add("p", 0, 1, digest, data)

    assert raised.value.code == "invalid_photo"
    assert staging.take("p") is None


async def test_a_new_photo_replaces_the_old_one() -> None:

    staging = PhotoStaging(FakeClock())
    first = jpeg_bytes(8, 8)
    second = jpeg_bytes(16, 16)
    for photo_id, photo in (("one", first), ("two", second)):
        staging.add(
            photo_id, 0, 1, hashlib.sha256(photo).hexdigest(), base64.b64encode(photo).decode()
        )

    assert staging.take("one") is None
    assert staging.take("two") == second


# --- estado em disco -------------------------------------------------------------------------


def test_state_file_survives_a_corrupt_file(tmp_path: Path) -> None:
    path = tmp_path / "s.json"
    path.write_text("{ não é json", encoding="utf-8")
    state = LivreStateFile(path)

    assert state.load() == {}
    state.save({"factory": FACTORY})
    assert state.load() == {"factory": FACTORY}
    state.delete()
    assert state.load() == {}


# --- a TV que imprime ruído antes de cada resposta -------------------------------------------


async def test_the_whole_flow_works_with_noise_before_every_answer(tmp_path: Path) -> None:
    livre, android, state, _ = make(tmp_path, FakeAndroid(noise=True))

    assert (await livre.read_state()).supported is True
    await livre.run({"action": "install"})
    await livre.run({"action": "set-home", "disableFactory": True})
    await expect_error(livre, {"action": "set-apps", "disable": [IME]}, "protected_package")
    await livre.run({"action": "restore"})

    assert state.load() == {}
    assert android.home == FACTORY
    assert android.black_screen is False


# --- a home nova precisa abrir de verdade ----------------------------------------------------


async def test_install_reports_a_launcher_that_installs_but_does_not_open(tmp_path: Path) -> None:
    android = FakeAndroid()
    android.dead.add(PACKAGE)
    livre, android, _, _ = make(tmp_path, android)

    await expect_error(livre, {"action": "install"}, "launcher_not_running")

    assert android.home == FACTORY


async def test_set_home_refuses_a_launcher_that_does_not_stay_running(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    android.dead.add(PACKAGE)

    await expect_error(
        livre, {"action": "set-home", "disableFactory": True}, "launcher_not_running"
    )

    # Nada foi tocado na tela inicial nem no launcher de fábrica.
    assert not any(c.startswith("cmd package set-home-activity") for c in android.log)
    assert not any(c.startswith("pm disable") for c in android.log)
    assert android.home == FACTORY


async def test_a_home_that_does_not_open_after_set_home_goes_back_to_the_original(
    tmp_path: Path,
) -> None:
    livre, android, _, _ = await installed(tmp_path)
    android.fail_open_when_current_home.add(HOME_COMPONENT)

    await expect_error(
        livre, {"action": "set-home", "disableFactory": True}, "launcher_not_running"
    )

    assert android.home == FACTORY
    assert not any(c.startswith("pm disable") for c in android.log)
    assert f"am start -n {FACTORY}" in android.log
    assert android.black_screen is False


async def test_a_home_that_dies_after_disabling_the_factory_reenables_it(tmp_path: Path) -> None:
    livre, android, state, _ = await installed(tmp_path)
    android.die_after_disable = True

    await expect_error(livre, {"action": "set-home", "disableFactory": True}, "verify_failed")

    assert FACTORY_PACKAGE not in android.disabled
    assert android.home == FACTORY
    assert state.load()["disabled"] == []
    assert android.black_screen is False


async def test_restore_does_not_uninstall_when_the_original_does_not_open(tmp_path: Path) -> None:
    livre, android, _, _ = await installed(tmp_path)
    await livre.run({"action": "set-home"})
    android.dead.add(FACTORY_PACKAGE)
    android.log.clear()

    await expect_error(livre, {"action": "restore"}, "verify_failed")

    assert not any(c.startswith("pm uninstall") for c in android.log)
    assert android.installed is True


async def test_restore_reopens_the_previous_home_when_the_original_activity_fails(
    tmp_path: Path,
) -> None:
    livre, android, _, _ = await installed(tmp_path)
    await livre.run({"action": "set-home"})
    android.fail_open_when_current_home.add(FACTORY)
    android.log.clear()

    await expect_error(livre, {"action": "restore"}, "verify_failed")

    assert not any(c.startswith("pm uninstall") for c in android.log)
    assert android.home == HOME_COMPONENT
    assert (
        f"am start -n {HOME_COMPONENT}"
        in android.log[android.log.index(f"am start -n {FACTORY}") :]
    )
    assert android.installed is True


@pytest.mark.parametrize(
    "broken",
    ["truncated", "garbage-after-header", "huge-side"],
)
async def test_a_jpeg_that_does_not_decode_is_refused(broken: str) -> None:
    photo = jpeg_bytes(64, 48)
    if broken == "truncated":
        photo = photo[: len(photo) // 2]
    elif broken == "garbage-after-header":
        photo = photo[:20] + bytes(len(photo) - 20)
    else:
        photo = jpeg_bytes(4097, 8)
    staging = PhotoStaging(FakeClock())

    with pytest.raises(LivreError) as raised:
        staging.add("p", 0, 1, hashlib.sha256(photo).hexdigest(), base64.b64encode(photo).decode())

    assert raised.value.code == "invalid_photo"
