"""Handlers do TV Livre: estado antes do resultado, códigos estáveis, pedaços da foto e o portão.

As mensagens que o agente envia passam pelo `EnvelopeGate` (esquema JSON + modelo gerado do
contrato), então um estado fora do contrato falha aqui e não na API.
"""

import asyncio
import base64
import hashlib
import threading
from pathlib import Path

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTransport
from uniover_agent.composition.connection import declarable_capabilities
from uniover_agent.core import Command, EnvelopeFactory, EnvelopeGate, Handler, ResultStatus
from uniover_agent.core.tv import livre as livre_module
from uniover_agent.core.tv.livre import (
    CAPABILITY,
    EXTENDED_CAPABILITY,
    NOTICE_CAPABILITY,
    SLEEP_NO_INSTALL_CAPABILITY,
    LivreStateFile,
    PhotoStaging,
    TvLivre,
    tv_livre_handler,
    tv_livre_photo_handler,
)
from uniover_agent.ports import AdbUnreachable, TransportError
from uniover_agent.ports.tv_livre import LauncherApkError, ShellResult

from .support import AGENT_ID
from .support_livre import FACTORY, NETFLIX, FakeAndroid, FakeApkSource, jpeg_bytes

REQUEST_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea0"
COMMAND_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f"
PHOTO_ID = "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8ea1"


def build(  # noqa: PLR0913 - opções independentes da montagem
    tmp_path: Path,
    android: FakeAndroid | None = None,
    error: LauncherApkError | None = None,
    *,
    extended: bool = False,
    notice: bool = False,
    published: bool = False,
    apk: FakeApkSource | None = None,
    clock: FakeClock | None = None,
) -> tuple[Handler, FakeTransport, FakeAndroid, TvLivre]:
    clock = clock or FakeClock()
    android = android or FakeAndroid()
    livre = TvLivre(
        android,
        apk or FakeApkSource(tmp_path, error),
        LivreStateFile(tmp_path / "tv-livre.json"),
        PhotoStaging(clock),
        clock,
        extended=lambda: extended,
        notice=lambda: notice,
        published=lambda: published,
    )
    transport = FakeTransport()
    handler = tv_livre_handler(
        livre, transport, EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock)
    )
    return handler, transport, android, livre


def command(body: dict[str, object]) -> Command:
    return Command(COMMAND_ID, "tv.livre.v1", {"requestId": REQUEST_ID, **body})


async def test_status_sends_the_state_correlated_to_the_command_and_succeeds(
    tmp_path: Path,
) -> None:
    handler, transport, _, _ = build(tmp_path)

    result = await handler(command({"action": "status"}))

    assert result.status is ResultStatus.OK
    (sent,) = transport.sent
    assert sent["type"] == "tv.livre.state.v1"
    assert sent["correlationId"] == COMMAND_ID
    body = sent["body"]
    assert body["requestId"] == REQUEST_ID
    assert body["supported"] is True
    assert body["installed"] is False
    assert {app["package"] for app in body["apps"]} >= {NETFLIX}


async def test_install_reports_the_new_state(tmp_path: Path) -> None:
    handler, transport, _, _ = build(tmp_path)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    body = transport.sent[-1]["body"]
    assert body["installed"] is True
    assert body["version"] == "0.30.0"
    assert body["isHome"] is False
    assert body["factoryLauncher"] == FACTORY


async def test_the_new_state_fields_go_only_to_an_api_that_lists_them(tmp_path: Path) -> None:
    handler, transport, _, _ = build(tmp_path, extended=False)
    await handler(command({"action": "install"}))
    old = transport.sent[-1]["body"]
    assert "launcherLevel" not in old
    assert "applyDeferred" not in old

    handler, transport, _, _ = build(tmp_path / "new", extended=True)
    await handler(command({"action": "install"}))
    new = transport.sent[-1]["body"]
    assert new["launcherLevel"] == 2
    assert "applyDeferred" not in new


async def test_the_published_version_goes_with_an_installed_launcher(tmp_path: Path) -> None:
    apk = FakeApkSource(tmp_path)
    apk.published = "0.31.0"
    handler, transport, _, _ = build(tmp_path, published=True, apk=apk)

    # Sem o app na TV não há o que comparar.
    await handler(command({"action": "status"}))
    assert "publishedVersion" not in transport.sent[-1]["body"]

    await handler(command({"action": "install"}))
    body = transport.sent[-1]["body"]
    assert (body["version"], body["publishedVersion"]) == ("0.30.0", "0.31.0")


@pytest.mark.parametrize(
    ("publication", "level"),
    [
        pytest.param("0.30.1", 2, id="publicada mais nova"),
        pytest.param("0.30.0", 2, id="igual"),
        pytest.param("0.29.9", 2, id="instalada mais nova"),
        pytest.param("0.30.0", 1, id="nível antigo"),
    ],
)
async def test_the_agent_tells_both_versions_and_the_level_without_judging(
    tmp_path: Path, publication: str, level: int
) -> None:
    android = FakeAndroid()
    android.level = level
    apk = FakeApkSource(tmp_path)
    apk.published = publication
    handler, transport, _, _ = build(tmp_path, android, extended=True, published=True, apk=apk)

    await handler(command({"action": "install"}))

    body = transport.sent[-1]["body"]
    assert (body["version"], body["publishedVersion"], body["launcherLevel"]) == (
        "0.30.0",
        publication,
        level,
    )
    assert android.mutating().count("install") == 1  # só a instalação pedida


async def test_the_publication_is_asked_while_the_tv_is_still_being_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    tv_read = asyncio.Event()

    class SlowPublication(FakeApkSource):
        async def published_version(self) -> str | None:
            order.append("publicação pedida")
            await tv_read.wait()
            return "0.31.0"

    android = FakeAndroid()
    android.installed = True
    original = android.shell

    async def shell(text: str) -> ShellResult:
        await asyncio.sleep(0)  # o ADB de verdade cede a vez ao laço
        result = await original(text)
        if text == "pm list packages -d":  # a última leitura do estado
            order.append("TV lida")
            tv_read.set()
        return result

    monkeypatch.setattr(android, "shell", shell)
    handler, transport, _, _ = build(
        tmp_path, android, published=True, apk=SlowPublication(tmp_path)
    )

    await asyncio.wait_for(handler(command({"action": "status"})), 5)

    assert order[-2:] == ["publicação pedida", "TV lida"]
    assert transport.sent[-1]["body"]["publishedVersion"] == "0.31.0"


@pytest.mark.parametrize("failure", ["sem o app", "TV fora do alcance"])
async def test_an_unneeded_lookup_is_not_awaited_nor_left_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    class NeverAnswers(FakeApkSource):
        async def published_version(self) -> str | None:
            await asyncio.Event().wait()
            return None

    android = FakeAndroid()

    async def shell(text: str) -> ShellResult:
        await asyncio.sleep(0)
        if failure == "TV fora do alcance":
            raise AdbUnreachable("a TV não respondeu pelo ADB")
        return await FakeAndroid.shell(android, text)

    monkeypatch.setattr(android, "shell", shell)
    handler, _, _, _ = build(tmp_path, android, published=True, apk=NeverAnswers(tmp_path))
    before = asyncio.all_tasks()

    await asyncio.wait_for(handler(command({"action": "status"})), 5)

    assert asyncio.all_tasks() == before


async def test_an_api_that_does_not_list_the_published_version_never_gets_it(
    tmp_path: Path,
) -> None:
    apk = FakeApkSource(tmp_path)
    apk.published = "0.31.0"
    # A API anterior lista os outros acréscimos e tem o estado fechado sem o campo.
    handler, transport, _, _ = build(tmp_path, extended=True, notice=True, apk=apk)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    assert "publishedVersion" not in transport.sent[-1]["body"]
    assert apk.version_reads == 0


async def test_an_unreadable_publication_leaves_the_field_out(tmp_path: Path) -> None:
    handler, transport, _, _ = build(tmp_path, published=True)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    assert transport.sent[-1]["body"]["installed"] is True
    assert "publishedVersion" not in transport.sent[-1]["body"]


async def test_the_published_version_is_remembered_for_a_while_and_a_failure_for_less(
    tmp_path: Path,
) -> None:
    clock = FakeClock()
    apk = FakeApkSource(tmp_path)
    _, _, _, livre = build(tmp_path, apk=apk, clock=clock)

    assert await livre.published_version() is None
    apk.published = "1.0.0"
    clock.advance(livre_module.PUBLISHED_VERSION_RETRY_SECONDS - 1)
    assert await livre.published_version() is None
    clock.advance(1)
    assert await livre.published_version() == "1.0.0"
    assert apk.version_reads == 2

    apk.published = "1.1.0"
    clock.advance(livre_module.PUBLISHED_VERSION_TTL_SECONDS - 1)
    assert await livre.published_version() == "1.0.0"
    clock.advance(1)
    assert await livre.published_version() == "1.1.0"
    assert apk.version_reads == 3


async def test_installing_reads_the_published_version_again(tmp_path: Path) -> None:
    apk = FakeApkSource(tmp_path)
    apk.published = "1.0.0"
    handler, transport, _, _ = build(tmp_path, published=True, apk=apk)
    await handler(command({"action": "install"}))
    apk.published = "1.1.0"

    await handler(command({"action": "status"}))
    assert transport.sent[-1]["body"]["publishedVersion"] == "1.0.0"

    await handler(command({"action": "install"}))
    assert transport.sent[-1]["body"]["publishedVersion"] == "1.1.0"
    assert apk.fetches == 2


async def test_a_deferred_apply_is_told_once_and_only_to_a_new_api(tmp_path: Path) -> None:
    handler, transport, android, _ = build(tmp_path, extended=True)
    await handler(command({"action": "install"}))
    android.foreground = NETFLIX
    config = '{"clock":{"size":"small"}}'

    result = await handler(command({"action": "apply", "revision": 3, "configJson": config}))
    assert result.status is ResultStatus.OK
    assert transport.sent[-1]["body"]["applyDeferred"] is True

    android.foreground = None
    await handler(command({"action": "apply", "revision": 4, "configJson": config}))
    assert "applyDeferred" not in transport.sent[-1]["body"]


async def test_sleep_without_install_checks_the_launcher_again(tmp_path: Path) -> None:
    handler, transport, android, _ = build(tmp_path)
    await handler(command({"action": "install"}))
    await handler(command({"action": "status"}))
    assert transport.sent[-1]["body"]["installed"] is True
    android.installed = False
    android.log.clear()

    result = await handler(command({"action": "sleep", "skipInstall": True}))

    assert result.status is ResultStatus.REJECTED
    assert result.code == "launcher_required"
    assert transport.sent[-1]["body"]["installed"] is False
    assert not any("install" in entry or ".SleepActivity" in entry for entry in android.log)


async def test_the_sleep_time_reaches_the_tv_and_a_bad_one_is_refused(tmp_path: Path) -> None:
    handler, _, android, _ = build(tmp_path, extended=True)
    await handler(command({"action": "install"}))

    assert (await handler(command({"action": "sleep", "minutes": 30}))).status is ResultStatus.OK
    assert (
        "am start -n br.uniover.launcher/.SleepActivity "
        "--ei br.uniover.launcher.extra.MAX_MINUTES 30"
    ) in android.log

    refused = await handler(command({"action": "sleep", "minutes": 9999}))
    assert refused.status is ResultStatus.REJECTED
    assert refused.code == "invalid_minutes"


async def test_a_refusal_by_rule_is_rejected_with_the_stable_code_and_still_reports_state(
    tmp_path: Path,
) -> None:
    handler, transport, _, _ = build(tmp_path)

    result = await handler(command({"action": "apply", "revision": 1, "configJson": "{}"}))

    assert (result.status, result.code) == (ResultStatus.REJECTED, "not_installed")
    assert transport.sent[-1]["type"] == "tv.livre.state.v1"


async def test_an_unsupported_tv_gets_a_state_with_supported_false(tmp_path: Path) -> None:
    handler, transport, _, _ = build(tmp_path, FakeAndroid(sdk=26))

    result = await handler(command({"action": "install"}))

    assert (result.status, result.code) == (ResultStatus.REJECTED, "unsupported")
    assert transport.sent[-1]["body"]["supported"] is False


async def test_download_failures_keep_their_codes(tmp_path: Path) -> None:
    error = LauncherApkError("apk_hash_mismatch", "O launcher baixado não confere.")
    handler, _, _, _ = build(tmp_path, error=error)

    result = await handler(command({"action": "install"}))

    assert (result.status, result.code) == (ResultStatus.FAILED, "apk_hash_mismatch")


async def test_an_unexpected_error_never_leaks_its_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    android = FakeAndroid()
    handler, _, _, livre = build(tmp_path, android)

    async def boom(_: dict[str, object]) -> None:
        raise RuntimeError("segredo interno")

    monkeypatch.setattr(livre, "run", boom)

    result = await handler(command({"action": "sleep"}))

    assert (result.status, result.code) == (ResultStatus.FAILED, "livre_failed")
    assert "segredo" not in result.detail


async def test_an_unreachable_tv_fails_with_the_adb_code_and_sends_no_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    handler, transport, android, _ = build(tmp_path)

    async def down(_: str) -> ShellResult:
        raise AdbUnreachable("a TV não respondeu pelo ADB")

    monkeypatch.setattr(android, "shell", down)

    result = await handler(command({"action": "status"}))

    assert (result.status, result.code) == (ResultStatus.FAILED, "adb_unreachable")
    assert transport.sent == []


async def test_a_lost_connection_to_the_api_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    handler, transport, _, _ = build(tmp_path)

    async def broken(_: dict[str, object]) -> None:
        raise TransportError("caiu")

    monkeypatch.setattr(transport, "send", broken)

    result = await handler(command({"action": "status"}))

    assert (result.status, result.code) == (ResultStatus.FAILED, "send_failed")


async def test_a_command_without_request_id_is_rejected(tmp_path: Path) -> None:
    handler, transport, android, _ = build(tmp_path)

    result = await handler(Command(COMMAND_ID, "tv.livre.v1", {"action": "install"}))

    assert result.status is ResultStatus.REJECTED
    assert transport.sent == []
    assert android.mutating() == []


async def test_every_action_is_audited(tmp_path: Path) -> None:
    handler, _, _, livre = build(tmp_path)

    await handler(command({"action": "install"}))
    await handler(command({"action": "set-apps", "disable": ["com.example.bloatware"]}))

    audit = livre._state.load()["audit"]
    assert [entry["action"] for entry in audit] == ["install", "set-apps"]
    assert audit[0]["result"] == "ok"


# --- foto ------------------------------------------------------------------------------------


def chunk(index: int, total: int, photo: bytes, part: bytes) -> Command:
    return Command(
        COMMAND_ID,
        "tv.livre.photo.v1",
        {
            "photoId": PHOTO_ID,
            "index": index,
            "total": total,
            "sha256": hashlib.sha256(photo).hexdigest(),
            "data": base64.b64encode(part).decode(),
        },
    )


async def test_photo_pieces_are_accepted_and_the_photo_is_staged() -> None:
    staging = PhotoStaging(FakeClock())
    handler = tv_livre_photo_handler(staging)
    photo = jpeg_bytes()

    first = await handler(chunk(0, 2, photo, photo[:50]))
    second = await handler(chunk(1, 2, photo, photo[50:]))

    assert first.status is second.status is ResultStatus.OK
    assert staging.take(PHOTO_ID) == photo


async def test_only_the_final_check_of_the_photo_leaves_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    checked_on: list[int] = []
    original = livre_module.is_decodable_jpeg

    def spy(photo: bytes) -> bool:
        checked_on.append(threading.get_ident())
        return original(photo)

    monkeypatch.setattr(livre_module, "is_decodable_jpeg", spy)
    staging = PhotoStaging(FakeClock())
    handler = tv_livre_photo_handler(staging)
    photo = jpeg_bytes()

    first = await handler(chunk(0, 2, photo, photo[:50]))
    assert checked_on == []  # um pedaço do meio só é guardado
    second = await handler(chunk(1, 2, photo, photo[50:]))

    assert first.status is second.status is ResultStatus.OK
    assert len(checked_on) == 1
    assert checked_on[0] != loop_thread
    # Quem chamou esperou a conferência: a foto já está pronta para o `apply` seguinte.
    assert staging.take(PHOTO_ID) == photo


async def test_a_corrupt_photo_is_rejected_with_a_stable_code() -> None:
    staging = PhotoStaging(FakeClock())
    handler = tv_livre_photo_handler(staging)
    photo = jpeg_bytes()
    bad = chunk(0, 1, b"outra coisa", photo)

    result = await handler(bad)

    assert (result.status, result.code) == (ResultStatus.REJECTED, "invalid_photo")
    assert staging.take(PHOTO_ID) is None


async def test_the_state_message_matches_the_contract_for_a_full_flow(tmp_path: Path) -> None:
    handler, transport, _, _ = build(tmp_path)

    bodies: list[dict[str, object]] = [
        {"action": "install"},
        {"action": "set-home", "disableFactory": True},
        {"action": "set-apps", "disable": ["com.example.bloatware"]},
    ]
    for body in bodies:
        assert (await handler(command(body))).status is ResultStatus.OK

    body = transport.sent[-1]["body"]
    assert body["isHome"] is True
    assert set(body["disabledPackages"]) == {
        "com.google.android.apps.tv.launcherx",
        "com.example.bloatware",
    }
    assert any(app["disabled"] for app in body["apps"])


@pytest.mark.parametrize("action", ["install", "set-home", "restore", "apply", "set-apps", "sleep"])
async def test_nothing_is_changed_on_an_unsupported_tv(tmp_path: Path, action: str) -> None:
    handler, _, android, _ = build(tmp_path, FakeAndroid(leanback=False))

    result = await handler(command({"action": action}))

    assert result.code == "unsupported"
    assert android.mutating() == []


def test_the_livre_extension_only_reaches_the_hello_after_the_api_lists_it() -> None:
    capabilities = [CAPABILITY, EXTENDED_CAPABILITY, SLEEP_NO_INSTALL_CAPABILITY]
    # Uma API anterior recusaria o `hello` com a capacidade nova: o módulo segue, sem ela.
    assert declarable_capabilities(capabilities, lambda _: False) == (CAPABILITY,)
    assert declarable_capabilities(
        capabilities, lambda feature: feature == EXTENDED_CAPABILITY
    ) == (CAPABILITY, EXTENDED_CAPABILITY)
    assert declarable_capabilities(capabilities, lambda _: True) == tuple(capabilities)


def test_the_notice_capability_only_reaches_the_hello_after_the_api_lists_it() -> None:
    capabilities = [CAPABILITY, EXTENDED_CAPABILITY, NOTICE_CAPABILITY]
    # A API que já lista `tv.livre.v2` mas não o aviso: o `hello` não o declara.
    assert declarable_capabilities(
        capabilities, lambda feature: feature == EXTENDED_CAPABILITY
    ) == (CAPABILITY, EXTENDED_CAPABILITY)
    assert declarable_capabilities(capabilities, lambda _: True) == tuple(capabilities)


def tcl_without_package() -> FakeAndroid:
    android = FakeAndroid()
    android.manufacturer, android.brand = "TCL", "TCL"
    android.tcl_tv_installed = False
    android.fail.add("install-existing")
    return android


async def test_a_failed_tcl_restore_reaches_the_owner_in_an_otherwise_ok_result(
    tmp_path: Path,
) -> None:
    handler, _, _, _ = build(tmp_path, tcl_without_package())

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.FAILED
    assert result.code == livre_module.TCL_PACKAGE_MISSING
    assert "com.tcl.tv" in result.detail


async def test_a_restored_tcl_package_keeps_the_result_ok(tmp_path: Path) -> None:
    android = FakeAndroid()
    android.manufacturer, android.brand = "TCL", "TCL"
    android.tcl_tv_installed = False
    handler, _, _, _ = build(tmp_path, android)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    # Sem a capacidade `tv.livre.notice.v1` o contrato fechado da API anterior recusaria o campo.
    assert result.notice == ""


async def test_the_notice_is_not_sent_to_an_api_with_tv_livre_v2_but_without_the_notice(
    tmp_path: Path,
) -> None:
    # A API em produção lista `tv.livre.v2` e tem o resultado fechado sem `notice`: mandá-lo faria
    # a API recusar o frame e o pedido terminar em tempo esgotado.
    android = FakeAndroid()
    android.manufacturer, android.brand = "TCL", "TCL"
    android.tcl_tv_installed = False
    handler, _, _, _ = build(tmp_path, android, extended=True, notice=False)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    assert result.notice == ""
    assert result.detail == ""


async def test_a_restored_tcl_package_notice_travels_in_the_ok_result_when_the_api_lists_it(
    tmp_path: Path,
) -> None:
    android = FakeAndroid()
    android.manufacturer, android.brand = "TCL", "TCL"
    android.tcl_tv_installed = False
    handler, _, _, _ = build(tmp_path, android, extended=True, notice=True)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    assert result.code == ""
    assert "com.tcl.tv" in result.notice
    assert result.detail == ""


async def test_an_ok_result_without_a_tcl_notice_has_no_notice_when_the_api_lists_it(
    tmp_path: Path,
) -> None:
    handler, _, _, _ = build(tmp_path, FakeAndroid(), extended=True, notice=True)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.OK
    assert result.notice == ""


async def test_a_failed_tcl_restore_keeps_the_error_message_when_the_api_lists_it(
    tmp_path: Path,
) -> None:
    handler, _, _, _ = build(tmp_path, tcl_without_package(), extended=True, notice=True)

    result = await handler(command({"action": "install"}))

    assert result.status is ResultStatus.FAILED
    assert result.code == livre_module.TCL_PACKAGE_MISSING
    assert "com.tcl.tv" in result.detail
    assert result.notice == ""


async def test_sleep_auto_install_failure_keeps_the_tcl_notice_with_the_error(
    tmp_path: Path,
) -> None:
    android = tcl_without_package()
    android.installed = False
    android.fail.add("SleepActivity")
    handler, _, _, _ = build(tmp_path, android)

    result = await handler(command({"action": "sleep"}))

    assert (result.status, result.code) == (ResultStatus.FAILED, "sleep_failed")
    assert "Modo Dormir" in result.detail
    assert "com.tcl.tv" in result.detail
