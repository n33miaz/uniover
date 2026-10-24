"""A sessão gentil com a TV: teste de vida, espera crescente, registro sem barulho, WOL e volume."""

import logging

import pytest

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.core import TV_UNREACHABLE, TvSessionError, TvSessionManager, TvState
from uniover_agent.ports import TvUnreachable


class Probe:
    """Teste de vida roteirizado: conta quantas vezes a rede foi tocada."""

    def __init__(self, alive: bool = False) -> None:
        self.alive = alive
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.alive


class Rig:
    def __init__(self, *, alive: bool = False, **kwargs: object) -> None:
        self.clock = FakeClock()
        self.remote = FakeTvRemote()
        self.probe = Probe(alive)
        self.states: list[TvState] = []
        kwargs.setdefault("rng", lambda: 0.5)  # sem variação: os passos saem exatos
        self.manager = TvSessionManager(
            self.clock,
            self.remote,
            liveness=self.probe,
            **kwargs,  # type: ignore[arg-type]
        )
        self.manager.subscribe(self.states.append)

    async def wake(self) -> str | None:
        try:
            await self.manager.wake()
        except TvSessionError as exc:
            return exc.code
        return None


# --- teste de vida antes do WebSocket --------------------------------------------------------


async def test_a_tv_that_does_not_answer_the_probe_never_gets_a_websocket() -> None:
    rig = Rig(alive=False)
    assert await rig.wake() == TV_UNREACHABLE
    assert rig.remote.connects == 0
    assert rig.manager.offline


async def test_a_tv_that_answers_the_probe_gets_the_session_opened_once() -> None:
    rig = Rig(alive=True)
    assert await rig.wake() is None
    assert (rig.probe.calls, rig.remote.connects) == (1, 1)
    # Sessão quente: pedir de novo não toca na rede (nem no teste de vida).
    assert await rig.wake() is None
    assert (rig.probe.calls, rig.remote.connects) == (1, 1)


async def test_a_tv_that_answers_the_probe_but_refuses_the_session_is_still_offline() -> None:
    rig = Rig(alive=True)
    rig.remote.connect_errors = [TvUnreachable("recusou") for _ in range(4)]
    assert await rig.wake() == TV_UNREACHABLE
    assert rig.manager.offline


# --- espera exponencial com teto -------------------------------------------------------------


async def attempts_after(rig: Rig, seconds: float) -> int:
    """Anda o relógio e pede de novo: quantas vezes o teste de vida foi tocado por esse pedido."""
    rig.clock.advance(seconds)
    before = rig.probe.calls
    await rig.wake()
    return rig.probe.calls - before


async def test_the_wait_grows_five_ten_twenty_forty_sixty_and_stays_at_sixty() -> None:
    rig = Rig()
    await rig.wake()  # a primeira queda: a TV pode só estar acordando, algumas tentativas curtas
    assert rig.probe.calls == 4
    for step in (5, 10, 20, 40, 60, 60, 60):
        # Um pouco antes do fim da espera: nada vai à rede. Um pouco depois: uma tentativa só.
        assert await attempts_after(rig, step - 0.5) == 0
        assert await attempts_after(rig, 1.0) == 1


async def test_the_random_variation_stays_within_twenty_percent() -> None:
    for rng, expected in ((lambda: 0.0, 4.0), (lambda: 1.0, 6.0)):
        rig = Rig(rng=rng)
        await rig.wake()
        assert await attempts_after(rig, expected - 0.1) == 0
        assert await attempts_after(rig, 0.2) == 1


async def test_requests_inside_the_wait_fail_at_once_without_touching_the_network() -> None:
    rig = Rig()
    await rig.wake()
    calls = rig.probe.calls
    for _ in range(20):
        assert await rig.wake() == TV_UNREACHABLE
    assert rig.probe.calls == calls
    assert rig.remote.connects == 0


async def test_a_person_waiting_can_skip_the_wait_but_not_the_five_second_floor() -> None:
    rig = Rig()
    await rig.wake()
    await attempts_after(rig, 6)  # a segunda queda: a próxima espera é de 10 s
    calls = rig.probe.calls
    rig.clock.advance(2)
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("UP")  # muito cedo, mesmo para quem espera
    assert rig.probe.calls == calls
    rig.clock.advance(4)  # 6 s depois da última tentativa, antes dos 10 s da espera
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("UP")
    assert rig.probe.calls == calls + 1  # tentou uma vez, não quatro


async def test_when_the_tv_comes_back_it_reconnects_by_itself_and_the_wait_restarts() -> None:
    rig = Rig()
    await rig.wake()
    await attempts_after(rig, 6)
    rig.probe.alive = True
    assert await attempts_after(rig, 11) == 1
    assert rig.manager.snapshot().connection == "hot"
    assert not rig.manager.offline

    # Cai de novo: recomeça nos 5 s (não no passo que tinha chegado).
    rig.probe.alive = False
    rig.remote.drop()
    await rig.manager.settle()
    assert rig.manager.offline
    calls = rig.probe.calls
    rig.clock.advance(4.5)
    assert await rig.wake() == TV_UNREACHABLE
    assert rig.probe.calls == calls
    rig.clock.advance(1)
    await rig.wake()
    assert rig.probe.calls == calls + 1


async def test_background_recovery_respects_the_wait_even_for_a_person_style_floor() -> None:
    rig = Rig(alive=True)
    await rig.wake()
    rig.probe.alive = False
    rig.remote.drop()
    await rig.manager.settle()
    calls = rig.probe.calls
    rig.remote.drop()  # um novo aviso de queda não vira rajada
    await rig.manager.settle()
    assert rig.probe.calls == calls


# --- o que se publica e o que se registra ----------------------------------------------------


async def test_the_published_state_says_the_tv_is_offline_and_never_that_it_is_off() -> None:
    rig = Rig()
    await rig.wake()
    snapshot = rig.manager.snapshot()
    assert (snapshot.connection, snapshot.power) == ("disconnected", "unknown")
    assert rig.states[-1] == snapshot


async def test_the_log_has_one_line_when_it_drops_one_when_it_returns_and_a_summary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = Rig(offline_summary_seconds=600)
    with caplog.at_level(logging.DEBUG, logger="uniover_agent.core.tv.session"):
        for _ in range(40):
            await rig.wake()
            rig.clock.advance(61)
        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warnings) == 1
        assert "ficou offline" in warnings[0].getMessage()
        summaries = [r for r in caplog.records if "segue offline" in r.getMessage()]
        # 40 minutos fora, um resumo a cada 10 minutos (e não uma linha por tentativa).
        assert 3 <= len(summaries) <= 5
        rig.probe.alive = True
        await rig.wake()
    returned = [r for r in caplog.records if "voltou" in r.getMessage()]
    assert len(returned) == 1
    # Nada de endereço no registro.
    assert not any("192.168" in r.getMessage() for r in caplog.records)


# --- Wake-on-LAN no lugar da tecla POWER ---------------------------------------------


class Wol:
    def __init__(self, sent: bool = True) -> None:
        self.sent = sent
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.sent


def acordando(rig: Rig, wol: Wol, *, after: float = 5.0) -> None:
    """A TV começa a atender ao teste de vida `after` segundos depois do pacote."""
    sent_at: list[float] = []

    async def comes_up() -> bool:
        rig.probe.calls += 1
        if wol.calls and not sent_at:
            sent_at.append(rig.clock.monotonic())
        return bool(sent_at) and rig.clock.monotonic() - sent_at[0] >= after

    rig.manager._liveness = comes_up


async def test_power_with_the_tv_off_the_network_sends_wake_on_lan_and_not_the_key() -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    acordando(rig, wol)
    await rig.manager.send_key("POWER")
    assert wol.calls == 1
    await rig.manager.settle()  # a tarefa de fundo viu a TV subir e abriu a sessão
    assert rig.remote.sent == []  # POWER é interruptor: nunca a tecla depois do WOL
    assert rig.manager.snapshot().connection == "hot"


async def test_the_power_command_returns_right_after_the_packet_and_does_not_hold_the_queue() -> (
    None
):
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    started = rig.clock.monotonic()
    await rig.manager.send_key("POWER")  # a TV nunca responde
    # Só as repetições do teste de vida (2 s); nada dos 25 s de espera pela TV.
    assert rig.clock.monotonic() - started < 5
    assert wol.calls == 1
    await rig.manager.settle()


async def test_wake_on_lan_with_no_answer_is_logged_by_the_background_task(
    caplog: pytest.LogCaptureFixture,
) -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    with caplog.at_level(logging.WARNING):
        await rig.manager.send_key("POWER")
        await rig.manager.settle()
    assert "não respondeu" in caplog.text
    assert rig.remote.sent == []


async def test_power_again_while_the_tv_is_booting_is_refused_for_a_minute() -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    await rig.manager.send_key("POWER")
    await rig.manager.settle()  # o WOL não teve resposta em 25 s
    rig.probe.alive = True  # a TV acaba de aparecer na rede, ainda ligando
    rig.clock.advance(15)  # passou a janela de repetição de 10 s, mas não a de 60 s
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == []  # a tecla desligaria a TV
    assert wol.calls == 1
    rig.clock.advance(60)
    await rig.manager.send_key("POWER")
    assert rig.remote.sent == [("POWER", "SHORT")]  # passada a janela, é um pedido novo


async def test_a_slow_network_is_not_taken_as_off_the_network() -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    answers = iter([False, False, True])

    async def flaky() -> bool:
        return next(answers, True)

    rig.manager._liveness = flaky
    await rig.manager.send_key("POWER")
    assert wol.calls == 0
    assert rig.remote.sent == [("POWER", "SHORT")]


async def test_power_to_turn_the_tv_off_never_becomes_wake_on_lan() -> None:
    """A TV está ligada; um teste de vida que falha (rede lenta) não pode virar pacote mágico."""
    wol = Wol()
    rig = Rig(alive=True, wake_on_lan=wol)
    await rig.wake()
    rig.remote.push_power(True)
    rig.clock.advance(400)
    await rig.manager.hibernate_if_idle()
    rig.probe.alive = False  # a rede falha agora
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("POWER")
    assert wol.calls == 0
    assert rig.remote.sent == []


async def test_power_after_the_tv_was_turned_off_by_the_agent_can_wake_it() -> None:
    wol = Wol()
    rig = Rig(alive=True, wake_on_lan=wol)
    await rig.wake()
    rig.remote.push_power(True)
    await rig.manager.send_key("POWER")  # desliga (a TV estava ligada)
    rig.probe.alive = False  # a TV em standby não atende
    rig.remote.drop()  # o standby derruba a sessão
    await rig.manager.settle()
    rig.clock.advance(30)
    await rig.manager.send_key("POWER")  # agora liga
    assert wol.calls == 1
    assert rig.remote.sent == [("POWER", "SHORT")]  # só a do desligamento


async def test_power_with_a_tv_known_to_be_off_wakes_it() -> None:
    wol = Wol()
    rig = Rig(alive=True, wake_on_lan=wol)
    await rig.wake()
    rig.remote.push_power(False)
    rig.clock.advance(400)
    await rig.manager.hibernate_if_idle()
    rig.probe.alive = False
    await rig.manager.send_key("POWER")
    assert wol.calls == 1


async def test_power_wake_on_lan_that_cannot_be_sent_fails_with_a_clear_message() -> None:
    rig = Rig(wake_on_lan=Wol(sent=False))
    with pytest.raises(TvSessionError) as caught:
        await rig.manager.send_key("POWER")
    assert "sinal de ligar" in caught.value.message
    # Nada foi enviado: o dono pode tentar de novo sem a janela de 60 s.
    rig.clock.advance(11)
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("POWER")


async def test_power_with_the_tv_reachable_is_the_normal_key_and_no_wake_on_lan() -> None:
    wol = Wol()
    rig = Rig(alive=True, wake_on_lan=wol)
    await rig.manager.send_key("POWER")
    assert (wol.calls, rig.remote.sent) == (0, [("POWER", "SHORT")])


async def test_other_keys_never_trigger_wake_on_lan() -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    with pytest.raises(TvSessionError):
        await rig.manager.send_key("HOME")
    assert wol.calls == 0


async def test_the_wake_prewarm_never_sends_wake_on_lan() -> None:
    wol = Wol()
    rig = Rig(wake_on_lan=wol)
    await rig.wake()
    assert wol.calls == 0


# --- volume: lido só depois de uma tecla de volume -------------------------------------------


class VolumeReader:
    def __init__(self, level: int | None = 17) -> None:
        self.level = level
        self.calls = 0
        self.fail = False

    async def __call__(self) -> int | None:
        self.calls += 1
        if self.fail:
            raise OSError("sem resposta")
        return self.level


async def test_the_volume_is_read_once_after_a_volume_key_and_published() -> None:
    reader = VolumeReader(17)
    rig = Rig(alive=True, volume_reader=reader)
    await rig.wake()
    await rig.manager.settle()
    assert reader.calls == 0  # abrir a sessão não lê o volume
    await rig.manager.send_key("VOLUME_UP")
    await rig.manager.settle()
    assert reader.calls == 1
    assert rig.manager.snapshot().volume == 17


async def test_a_burst_of_volume_keys_is_one_read() -> None:
    reader = VolumeReader(30)
    rig = Rig(alive=True, volume_reader=reader)
    for _ in range(6):
        await rig.manager.send_key("VOLUME_DOWN")
    await rig.manager.settle()
    assert reader.calls <= 2
    assert rig.manager.snapshot().volume == 30


async def test_other_keys_and_a_long_press_start_do_not_read_the_volume() -> None:
    reader = VolumeReader()
    rig = Rig(alive=True, volume_reader=reader)
    await rig.manager.send_key("HOME")
    await rig.manager.send_key("VOLUME_UP", "START_LONG")
    await rig.manager.settle()
    assert reader.calls == 0
    await rig.manager.send_key("VOLUME_UP", "END_LONG")
    await rig.manager.settle()
    assert reader.calls == 1


async def test_a_volume_read_that_fails_is_silent_and_does_not_break_the_key() -> None:
    reader = VolumeReader()
    reader.fail = True
    rig = Rig(alive=True, volume_reader=reader)
    await rig.manager.send_key("MUTE")
    await rig.manager.settle()
    assert rig.remote.sent == [("MUTE", "SHORT")]
    assert rig.manager.snapshot().volume is None


async def test_without_a_reader_volume_keys_just_work() -> None:
    rig = Rig(alive=True)
    await rig.manager.send_key("VOLUME_UP")
    assert rig.remote.sent == [("VOLUME_UP", "SHORT")]
