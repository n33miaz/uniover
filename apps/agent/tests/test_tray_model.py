"""O que o ícone da bandeja mostra: a cor segue a conexão, o selo segue a atualização."""

from datetime import UTC, datetime, timedelta

import pytest

from uniover_agent.core.tray_model import (
    BALLOON_FRESH_FOR,
    HEARTBEAT_STALE,
    MENU,
    RECONNECT_GRACE,
    TrayInputs,
    decide_state,
    needs_attention,
    should_notify_update_failure,
    status_summary,
    view_of,
)

NOW = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)


def inputs(**changes: object) -> TrayInputs:
    base: dict[str, object] = {"now": NOW, "connected": True, "since": NOW - timedelta(hours=1)}
    base.update(changes)
    return TrayInputs(**base)  # type: ignore[arg-type]


def test_connected_agent_is_green_without_the_seal() -> None:
    view = view_of(inputs(power="on", tv_name="Sala"))

    assert (view.state, view.attention) == ("connected", False)
    assert view.icon_file == "connected.ico"
    assert view.title == "UniOver: conectado - Sala ligada"


def test_a_fresh_drop_is_reconnecting_and_an_old_one_is_an_error() -> None:
    fresh = inputs(connected=False, since=NOW - RECONNECT_GRACE + timedelta(seconds=5))
    old = inputs(connected=False, since=NOW - RECONNECT_GRACE - timedelta(seconds=5))

    assert decide_state(fresh) == "reconnecting"
    assert decide_state(old) == "error"
    # Sem saber desde quando, ainda é "reconectando": o agente pode ter acabado de abrir.
    assert decide_state(inputs(connected=False, since=None)) == "reconnecting"


def test_a_silent_agent_is_an_error_even_if_the_file_says_connected() -> None:
    silent = inputs(heartbeat_age=HEARTBEAT_STALE + timedelta(seconds=1))
    alive = inputs(heartbeat_age=timedelta(seconds=30))

    assert decide_state(silent) == "error"
    assert decide_state(alive) == "connected"
    # Sem arquivo de sinal de vida não há como saber: não vira erro por isso.
    assert decide_state(inputs(heartbeat_age=None)) == "connected"


def test_updating_wins_until_it_is_stale() -> None:
    running = inputs(update_outcome="updating", update_checked_at=NOW - timedelta(minutes=2))
    stuck = inputs(
        update_outcome="updating", update_checked_at=NOW - timedelta(hours=2), connected=False
    )

    assert decide_state(running) == "updating"
    assert decide_state(stuck) != "updating"


@pytest.mark.parametrize(
    ("outcome", "attention"),
    [
        ("failed", True),
        ("blocked", True),
        ("rolled_back", True),
        ("updated", False),
        ("up_to_date", False),
        ("not_checked", False),
        ("updating", False),
    ],
)
def test_the_seal_follows_the_update_outcome(outcome: str, attention: bool) -> None:
    assert needs_attention(inputs(update_outcome=outcome)) is attention


def test_a_connected_agent_with_a_failed_update_stays_green_with_the_seal() -> None:
    view = view_of(inputs(update_outcome="failed", update_checked_at=NOW))

    assert (view.state, view.attention) == ("connected", True)
    assert view.icon_file == "connected-attention.ico"
    assert "atenção" in view.title
    assert len(view.title) <= 127


def test_every_combination_names_an_icon_file() -> None:
    names = {
        view_of(inputs(connected=c, since=s, update_outcome=o, update_checked_at=NOW)).icon_file
        for c in (True, False)
        for s in (NOW, NOW - timedelta(hours=1))
        for o in ("not_checked", "failed", "updating")
    }

    assert names == {
        "connected.ico",
        "connected-attention.ico",
        "reconnecting.ico",
        "reconnecting-attention.ico",
        "error.ico",
        "error-attention.ico",
        "updating.ico",
    }


def test_the_menu_has_the_five_items_plus_update_now_in_order() -> None:
    entries = [entry for entry in MENU if entry is not None]

    assert [entry.label for entry in entries] == [
        "Abrir UniOver",
        "Status",
        "Ver Registro",
        "Atualizar Agora",
        "Reiniciar",
        "Sair",
    ]
    assert [entry.action for entry in entries] == [
        "open",
        "status",
        "log",
        "update",
        "restart",
        "quit",
    ]
    assert [entry.label for entry in entries if entry.default] == ["Abrir UniOver"]
    # "Sair" é sempre o último e vem depois de um separador.
    assert MENU[-1] is entries[-1]
    assert MENU[-2] is None


def test_status_summary_is_short_and_has_no_personal_data() -> None:
    current = inputs(power="off", tv_name="Sala", update_outcome="failed", update_checked_at=NOW)
    summary = status_summary(view_of(current), current, "a" * 40)

    assert summary.splitlines() == [
        "Agente: conectado",
        "TV: Sala desligada",
        "Atualização: falhou; veja o registro",
        "Versão: aaaaaaaaaaaa",
    ]


class TestBalloon:
    def test_only_a_failure_opens_the_balloon(self) -> None:
        for outcome in ("updated", "up_to_date", "updating", "not_checked", "blocked"):
            assert not should_notify_update_failure(outcome, NOW, None, NOW)
        assert should_notify_update_failure("failed", NOW, None, NOW)
        assert should_notify_update_failure("rolled_back", NOW, None, NOW)

    def test_the_same_result_never_notifies_twice(self) -> None:
        assert not should_notify_update_failure("failed", NOW, NOW.isoformat(), NOW)
        later = NOW + timedelta(hours=1)
        assert should_notify_update_failure("failed", later, NOW.isoformat(), later)

    def test_an_old_failure_does_not_notify_a_tray_that_just_opened(self) -> None:
        now = NOW + BALLOON_FRESH_FOR + timedelta(minutes=1)
        assert not should_notify_update_failure("failed", NOW, None, now)
        assert not should_notify_update_failure("failed", None, None, now)
