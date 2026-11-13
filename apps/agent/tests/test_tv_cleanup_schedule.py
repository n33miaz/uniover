"""Agendamento da limpeza automática só com relógio e ADB falsos."""

import asyncio
from collections.abc import Callable
from datetime import UTC, date, datetime

from uniover_agent.adapters.fakes import FakeClock, FakeTransport, FakeTvAdb
from uniover_agent.core.envelope_gate import EnvelopeGate
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.cleanup import TvCleanup
from uniover_agent.core.tv.cleanup_schedule import TvCleanupScheduler, is_user_activity
from uniover_agent.ports import AdbError, CleanupDayStore, LaunchableApp

AGENT_ID = "pc-tv"
FOREGROUND = "com.example.video"
HOME = "com.google.android.tvlauncher"  # o launcher que o `FakeTvAdb` declara como tela inicial


class MemoryDayStore:
    """O `CleanupDayStore` em memória: `saved` guarda o que o agendador gravou, na ordem."""

    def __init__(self, day: date | None = None) -> None:
        self.day = day
        self.saved: list[date] = []

    def load(self) -> date | None:
        return self.day

    def save(self, day: date) -> None:
        self.day = day
        self.saved.append(day)


def make(
    foreground: str | None = FOREGROUND,
    *,
    pressure: bool = True,
    day_store: CleanupDayStore | None = None,
    foreground_of: Callable[[], str | None] | None = None,
    adb_connected: Callable[[], bool] | None = None,
) -> tuple[TvCleanupScheduler, FakeTvAdb, FakeTransport, FakeClock]:
    """`pressure`: memória livre abaixo do limite de 160 MB (só assim a limpeza leve roda)."""
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main")])
    adb.running = frozenset({FOREGROUND})
    if pressure:
        adb.memory_mb = [100, 100, 120]
    transport = FakeTransport()
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        foreground_of or (lambda: foreground),
        day_store=day_store,
        adb_connected=adb_connected,
    )
    return scheduler, adb, transport, clock


async def test_first_responsive_session_of_the_day_runs_a_light_cleanup_without_stopping_apps() -> (
    None
):
    scheduler, adb, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert len(transport.sent) == 1
    assert transport.sent[0]["body"]["kind"] == "light"
    assert not any(
        step == "kill-background" or step.startswith("force-stop:") for step in adb.cleanup_log
    )


async def test_slow_remote_session_schedules_light_cleanup_after_it_opens() -> None:
    scheduler, _, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(10.1)

    await scheduler.run_pending()

    assert transport.sent[0]["body"]["kind"] == "light"
    assert transport.sent[0]["body"]["sessionOpenMs"] == 10100


async def test_deep_cleanup_is_skipped_when_media_is_playing() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = True
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert body["kind"] == "deep"
    assert body["result"] == "skipped"
    assert body["reason"] == "media-in-use"


async def test_deep_cleanup_records_recent_command_before_waiting_the_quiet_window() -> None:
    scheduler, _, transport, _ = make(foreground=HOME)
    scheduler.configure(False, True, 500, True)
    scheduler.note_session_opened(11)
    scheduler.note_command()

    await scheduler.run_pending()

    assert [m["body"].get("reason") for m in transport.sent] == ["recent-command"]
    # Nada dormiu dentro do ciclo; o alarme acorda o temporizador e, passada a janela quieta, a
    # TV segue ociosa e a profunda roda de verdade (sem repetir a linha de "pulada").
    for _ in range(3):
        await asyncio.sleep(0)
    await scheduler.run_pending()
    assert [m["body"]["result"] for m in transport.sent] == ["skipped", "completed"]


async def test_deep_cleanup_without_the_tv_option_is_skipped_and_touches_no_app() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(False, True, 500)  # a opção por TV de fechar apps fica desligada
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"], body["reason"]) == (
        "deep",
        "skipped",
        "app-closing-disabled",
    )
    assert not any(
        step in {"go-home", "kill-background"} or step.startswith("force-stop:")
        for step in adb.cleanup_log
    )


async def test_deep_cleanup_with_the_tv_option_on_closes_apps_when_nobody_is_using_the_tv() -> None:
    scheduler, adb, transport, clock = make(foreground=HOME)
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = False
    # Passou da janela sem comando do usuário.
    clock.advance(20 * 60)
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"]) == ("deep", "completed")
    assert "kill-background" in adb.cleanup_log


async def test_deep_cleanup_sends_no_home_or_kill_while_the_foreground_app_is_unknown() -> None:
    scheduler, adb, transport, clock = make(foreground=None)
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = False
    clock.advance(20 * 60)  # passou da janela quieta: só o app da frente desconhecido segura
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"], body["reason"]) == ("deep", "skipped", "app-in-use")
    assert not any(
        step in {"go-home", "kill-background"} or step.startswith("force-stop:")
        for step in adb.cleanup_log
    )


async def test_a_new_configuration_without_the_option_turns_app_closing_off_again() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(True, False, 160, True)
    scheduler.configure(True, False, 160, False)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert transport.sent[0]["body"]["kind"] == "light"
    assert not any(
        step.startswith("force-stop:") or step == "kill-background" for step in adb.cleanup_log
    )


def test_only_messages_that_mean_somebody_is_using_the_tv_open_the_quiet_window() -> None:
    assert is_user_activity("tv.key.v3")
    assert is_user_activity("tv.text.v1")
    assert is_user_activity("tv.app.launch.v1")
    for ignored in (
        "api.keepalive.v1",
        "tv.cleanup.config.v1",
        "tv.cleanup.v1",
        "agent.logs.request.v1",
    ):
        assert not is_user_activity(ignored)


async def test_a_keepalive_never_moves_the_quiet_window() -> None:
    scheduler, _, transport, clock = make(foreground=HOME)
    scheduler.configure(False, True, 500, True)
    scheduler.note_session_opened(11)
    clock.advance(20 * 60)

    scheduler.note_message("api.keepalive.v1")  # chega a cada poucos segundos
    await scheduler.run_pending()

    assert [m["body"]["result"] for m in transport.sent] == ["completed"]


async def test_a_deep_cleanup_waiting_for_quiet_does_not_hold_back_the_light_one() -> None:
    scheduler, _, transport, _ = make(foreground=None)
    scheduler.configure(True, True, 500, True)
    scheduler.note_session_opened(11)  # sessão lenta: pede a leve e a profunda
    scheduler.note_command()

    await scheduler.run_pending()

    sent = [(m["body"]["kind"], m["body"]["result"]) for m in transport.sent]
    # Sem o app da frente a leve não sabe qual poupar e diz isso (nada de "concluída" vazia); a
    # profunda, esperando a janela quieta, não a segura.
    assert sent == [("light", "skipped"), ("deep", "skipped")]
    assert transport.sent[0]["body"]["reason"] == "foreground-unverifiable"


async def test_cleanup_waits_while_focus_is_active_and_runs_after_it_releases() -> None:
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main")])
    adb.memory_mb = [100, 100, 120]
    transport = FakeTransport()
    focused = [True]
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: FOREGROUND,
        lambda: focused[0],
    )
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()
    assert transport.sent == []

    focused[0] = False
    scheduler.resume()
    await scheduler.run_pending()
    assert transport.sent[0]["body"]["kind"] == "light"


# --- só com a memória da TV sob pressão ----------------------------------------------------------


async def test_light_cleanup_is_dispensed_when_the_tv_has_memory_to_spare() -> None:
    store = MemoryDayStore()
    scheduler, adb, transport, clock = make(pressure=False, day_store=store)
    adb.memory_mb = [256]  # a leitura real do log: bem acima do limite de 160 MB
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert transport.sent == []
    assert adb.cleanup_log == ["memory"], "só a leitura da memória: nenhum app é tocado"
    # A avaliação do dia terminou (não precisou): um reinício não a repete.
    assert store.saved == [clock.now().astimezone().date()]


async def test_light_cleanup_runs_when_the_free_memory_is_under_the_threshold() -> None:
    scheduler, adb, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    (message,) = transport.sent
    assert (message["body"]["kind"], message["body"]["result"]) == ("light", "completed")
    assert "trim-memory:" + FOREGROUND not in adb.cleanup_log, "o app da frente é poupado"


async def test_the_threshold_is_the_one_configured_for_the_tv() -> None:
    scheduler, adb, transport, _ = make(pressure=False)
    adb.memory_mb = [200, 200, 220]
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert transport.sent == []  # 200 MB livres, limite 160

    scheduler, adb, transport, _ = make(pressure=False)
    adb.memory_mb = [200, 200, 220]
    scheduler.configure(True, False, 256)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert [m["body"]["result"] for m in transport.sent] == [
        "completed"
    ]  # 200 MB livres, limite 256


async def test_a_slow_session_does_not_clean_a_tv_that_has_memory() -> None:
    scheduler, adb, transport, _ = make(pressure=False)
    adb.memory_mb = [400]
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(12)

    await scheduler.run_pending()

    assert transport.sent == []


async def test_unreadable_memory_is_reported_once_a_day_with_the_error_code() -> None:
    store = MemoryDayStore()
    scheduler, adb, transport, clock = make(day_store=store)
    adb.cleanup_errors = {"memory": AdbError("sem resposta")}
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    (message,) = transport.sent
    assert (message["body"]["result"], message["body"]["reason"]) == ("skipped", "adb_failed")
    assert not any(step.startswith("trim-memory:") for step in adb.cleanup_log)
    assert store.saved == [clock.now().astimezone().date()]
    # Outra sessão no mesmo dia não repete a leitura nem o relatório.
    clock.advance(2 * 60 * 60)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert len(transport.sent) == 1


async def test_a_memory_reading_the_tv_did_not_answer_is_reported_as_unavailable() -> None:
    scheduler, adb, transport, _ = make()
    adb.memory_mb = [None]
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert [m["body"]["reason"] for m in transport.sent] == ["memory-unavailable"]


async def test_the_day_counts_in_local_time_not_in_utc() -> None:
    """Às 22h de Brasília já é o dia seguinte em UTC: a limpeza da manhã não pode ser perdida."""
    store = MemoryDayStore()
    instant = datetime(2026, 11, 6, 1, 0, tzinfo=UTC)
    clock = FakeClock(fixed=instant)
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main")])
    adb.memory_mb = [400]
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        FakeTransport(),
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: FOREGROUND,
        day_store=store,
    )
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    # O dia gravado é o da hora local do PC, e não a data UTC do relógio.
    assert store.saved == [instant.astimezone().date()]


# --- o dia da limpeza sobrevive ao reinício do agente --------------------------------------------


async def test_the_day_of_a_finished_cleanup_is_saved_and_a_restart_does_not_repeat_it() -> None:
    store = MemoryDayStore()
    scheduler, _, transport, clock = make(day_store=store)
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert len(transport.sent) == 1
    assert store.saved == [clock.now().astimezone().date()]

    # O agente reinicia (processo novo, memória vazia) e a sessão abre de novo no mesmo dia.
    restarted, _, again, _ = make(day_store=store)
    restarted.configure(True, False, 160)
    restarted.note_session_opened(1)
    await restarted.run_pending()

    assert again.sent == []


async def test_a_new_day_runs_again_after_a_restart() -> None:
    store = MemoryDayStore(day=date(2000, 1, 1))
    scheduler, _, transport, _ = make(day_store=store)
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert len(transport.sent) == 1


async def test_without_a_store_the_day_is_only_remembered_in_memory() -> None:
    scheduler, _, transport, _ = make()
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert len(transport.sent) == 1


# --- o app da frente (a limpeza leve não toca em app sem saber qual poupar) --------------------


async def test_light_cleanup_waits_for_the_foreground_app_to_arrive_after_the_session_opens() -> (
    None
):
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main"), LaunchableApp("com.example.other", ".M")])
    adb.running = frozenset({FOREGROUND, "com.example.other"})
    adb.memory_mb = [100, 100, 120]
    transport = FakeTransport()
    answers: list[str | None] = [None, None, FOREGROUND]
    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        lambda: answers.pop(0) if len(answers) > 1 else answers[0],
    )
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert clock.sleeps == [1.0, 1.0]
    assert [m["body"]["result"] for m in transport.sent] == ["completed"]
    # Agora há o que reduzir: o outro app recebe o pedido, o da frente não.
    assert "trim-memory:com.example.other" in adb.cleanup_log
    assert f"trim-memory:{FOREGROUND}" not in adb.cleanup_log


async def test_deep_cleanup_waits_for_the_foreground_app_after_a_first_unknown() -> None:
    answers: list[str | None] = [None, None, HOME]
    scheduler, adb, transport, clock = make(
        foreground_of=lambda: answers.pop(0) if len(answers) > 1 else answers[0]
    )
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = False
    clock.advance(20 * 60)
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    body = transport.sent[-1]["body"]
    assert (body["kind"], body["result"]) == ("deep", "completed")
    assert clock.sleeps[:2] == [1.0, 1.0], "esperou o app da frente chegar"
    assert "kill-background" in adb.cleanup_log


async def test_deep_cleanup_that_never_learns_the_foreground_app_waits_and_then_skips() -> None:
    scheduler, adb, transport, clock = make(foreground=None)
    scheduler.configure(False, True, 500, True)
    adb.media_playing_value = False
    clock.advance(20 * 60)
    scheduler.note_session_opened(11)

    await scheduler.run_pending()

    assert transport.sent[-1]["body"]["reason"] == "app-in-use"
    assert clock.sleeps.count(1.0) == 5, "esperou o app da frente antes de desistir"
    assert "kill-background" not in adb.cleanup_log


async def test_light_cleanup_without_any_foreground_app_is_reported_as_skipped_not_completed() -> (
    None
):
    store = MemoryDayStore()
    scheduler, adb, transport, clock = make(foreground=None, day_store=store)
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    (message,) = transport.sent
    assert message["body"]["result"] == "skipped"
    assert message["body"]["reason"] == "foreground-unverifiable"
    assert len(clock.sleeps) == 5, "esperou o app da frente antes de desistir"
    assert not any(step.startswith("trim-memory:") for step in adb.cleanup_log)
    assert store.saved == [clock.now().astimezone().date()]
    # Uma TV que nunca informa o app não gera uma linha "pulada" a cada sessão do dia.
    clock.advance(2 * 60 * 60)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()
    assert len(transport.sent) == 1


async def test_media_started_during_the_foreground_wait_holds_the_light_cleanup_back() -> None:
    clock = FakeClock()
    adb = FakeTvAdb([LaunchableApp(FOREGROUND, ".Main"), LaunchableApp("com.example.other", ".M")])
    adb.running = frozenset({FOREGROUND, "com.example.other"})
    adb.memory_mb = [100, 100, 120]
    transport = FakeTransport()
    focused = [False]
    waits = [0]

    def foreground() -> str | None:
        waits[0] += 1
        if waits[0] == 2:
            focused[0] = True  # a pessoa deu play enquanto se esperava o app da frente
        return None if waits[0] < 3 else FOREGROUND

    scheduler = TvCleanupScheduler(
        TvCleanup(adb, clock, allow_app_closing=False),
        adb,
        clock,
        transport,
        EnvelopeFactory(AGENT_ID, EnvelopeGate(AGENT_ID), clock),
        foreground,
        lambda: focused[0],
    )
    scheduler.configure(True, False, 160)
    scheduler.note_session_opened(1)

    await scheduler.run_pending()

    assert transport.sent == []
    assert not any(step.startswith("trim-memory:") for step in adb.cleanup_log)
    # Acabada a mídia, o gatilho segue pendente e a limpeza roda.
    focused[0] = False
    scheduler.resume()
    await scheduler.run_pending()
    assert [m["body"]["result"] for m in transport.sent] == ["completed"]


async def test_without_an_open_adb_channel_the_automatic_cleanup_touches_nothing() -> None:
    # Sem canal que já chegou a `device`, qualquer leitura reconectaria o ADB, e uma TV que revogou
    # a permissão mostraria o aviso sem ninguém ter pedido.
    connected = False
    store = MemoryDayStore()
    scheduler, adb, transport, _ = make(day_store=store, adb_connected=lambda: connected)
    scheduler.configure(True, True, 160, True)
    scheduler.note_session_opened(11)  # sessão lenta: leve e profunda pendentes

    await scheduler.run_pending()

    assert adb.cleanup_log == []
    assert transport.sent == []
    assert store.saved == []  # o dia não foi dado como avaliado

    connected = True  # a pessoa abriu o canal (Atualizar lista)
    scheduler.note_session_opened(1)
    await scheduler.run_pending()

    assert adb.cleanup_log != []
    assert store.saved != []
