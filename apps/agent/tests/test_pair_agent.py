import pytest

from uniover_agent.adapters.fakes import FakeClock, FakePairingClient, FakeSecretStore
from uniover_agent.core import PairAgent
from uniover_agent.ports import (
    PairingDenied,
    PairingExpired,
    PairingInfo,
    PairingRateLimited,
    PairingTicket,
    PairingUnavailable,
    PollApproved,
    PollPending,
    PollSlowDown,
)

INFO = PairingInfo("PC da sala", "Windows 11", "0.1.0")
TICKET = PairingTicket("pid-1", "DEVICE-CODE-SECRETO", "ABCD-2345", expires_in=600, interval=5)
APPROVED = PollApproved("pc-da-sala", "uo_dev_token-de-teste")


def make(
    polls: list[PollApproved | PollPending | PollSlowDown | Exception],
) -> tuple[PairAgent, FakePairingClient, FakeSecretStore, FakeClock]:
    client = FakePairingClient(TICKET, list(polls))
    secrets = FakeSecretStore()
    clock = FakeClock()
    return PairAgent(client, secrets, clock), client, secrets, clock


async def test_happy_path_stores_token_in_secret_store() -> None:
    use_case, client, secrets, clock = make([PollPending(), PollPending(), APPROVED])
    shown: list[PairingTicket] = []
    paired = await use_case(INFO, shown.append)
    assert paired.agent_id == "pc-da-sala"
    assert secrets.get("pc-da-sala") == "uo_dev_token-de-teste"
    assert shown == [TICKET]
    assert client.started == [INFO]
    assert clock.sleeps == [5, 5, 5]


async def test_slow_down_increases_the_interval() -> None:
    use_case, _, _, clock = make([PollSlowDown(10), PollPending(), APPROVED])
    await use_case(INFO, lambda _: None)
    assert clock.sleeps == [5, 10, 10]


async def test_expired_code_raises_and_stores_nothing() -> None:
    use_case, _, secrets, _ = make([PollPending(), PairingExpired("410")])
    with pytest.raises(PairingExpired):
        await use_case(INFO, lambda _: None)
    assert secrets.get("pc-da-sala") is None


async def test_gives_up_when_the_deadline_passes_without_approval() -> None:
    use_case, client, _, clock = make([PollPending()] * 200)
    with pytest.raises(PairingExpired):
        await use_case(INFO, lambda _: None)
    assert clock.monotonic() >= TICKET.expires_in
    assert client.poll_count < 200


async def test_denied_is_propagated() -> None:
    use_case, _, secrets, _ = make([PairingDenied("403")])
    with pytest.raises(PairingDenied):
        await use_case(INFO, lambda _: None)
    assert secrets.get("pc-da-sala") is None


async def test_rate_limit_waits_retry_after() -> None:
    use_case, _, _, clock = make([PairingRateLimited(30), APPROVED])
    await use_case(INFO, lambda _: None)
    assert clock.sleeps == [5, 30]


async def test_poll_survives_a_sleeping_api() -> None:
    use_case, client, _, _ = make([PairingUnavailable("502"), PairingUnavailable("502"), APPROVED])
    await use_case(INFO, lambda _: None)
    assert client.poll_count == 3


async def test_start_retries_while_the_api_wakes_up() -> None:
    use_case, client, _, clock = make([APPROVED])
    client.start_errors = [PairingUnavailable("503"), PairingUnavailable("503")]
    await use_case(INFO, lambda _: None)
    assert len(client.started) == 3
    assert clock.sleeps[:2] == [5, 5]


async def test_start_gives_up_after_the_patience_runs_out() -> None:
    use_case, client, _, _ = make([])
    client.start_errors = [PairingUnavailable("503")] * 500
    with pytest.raises(PairingUnavailable):
        await use_case(INFO, lambda _: None)
    assert len(client.started) < 500


def test_ticket_repr_hides_device_code() -> None:
    assert "DEVICE-CODE-SECRETO" not in repr(TICKET)
    assert "uo_dev_token-de-teste" not in repr(APPROVED)
