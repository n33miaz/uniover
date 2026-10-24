"""O reencontro da TV pelo núcleo: ARP, depois SSDP, depois varredura lenta (relógio falso)."""

import asyncio

import pytest

from uniover_agent.adapters.fakes import FakeClock
from uniover_agent.core import TvIdentity, TvKnown, TvLocator

MAC = "74:6D:FA:5D:52:08"
DUID = "12ce8c0c-730b-4300-84e7-3ae19e12e536"
ME = TvIdentity((DUID, MAC), MAC)
OTHER = TvIdentity(("outra-tv", "AA:BB:CC:00:00:01"), "AA:BB:CC:00:00:01")


class World:
    """Rede de mentira com contadores: o que foi lido, consultado e a maior fila de conexões."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.arp: dict[str, list[str]] = {}
        self.ssdp: list[str] = []
        self.identities: dict[str, TvIdentity] = {}
        self.open_hosts: set[str] = set()
        self.hosts = [f"192.168.0.{number}" for number in range(1, 255) if number != 12]
        self.calls: list[str] = []
        self.probed: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.probe_times: list[float] = []

    async def arp_table(self) -> dict[str, list[str]]:
        self.calls.append("arp")
        return self.arp

    async def ssdp_search(self) -> list[str]:
        self.calls.append("ssdp")
        return self.ssdp

    async def identify(self, host: str) -> TvIdentity | None:
        self.calls.append(f"identify:{host}")
        return self.identities.get(host)

    async def probe(self, host: str) -> bool:
        self.probed.append(host)
        self.probe_times.append(self.clock.monotonic())
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        await asyncio.sleep(0)  # a conexão leva um turno do laço: as outras emparelham
        self.in_flight -= 1
        return host in self.open_hosts

    def locator(self, known: TvKnown | None = None, **limits: float) -> TvLocator:
        return TvLocator(
            self.clock,
            known or TvKnown(DUID, MAC),
            arp_table=self.arp_table,
            ssdp=self.ssdp_search,
            hosts=lambda: self.hosts,
            probe=self.probe,
            identify=self.identify,
            **limits,  # type: ignore[arg-type]
        )

    def stages(self) -> list[str]:
        return [call.split(":")[0] for call in self.calls]


def world() -> World:
    return World(FakeClock())


# --- a ordem: ARP, SSDP, varredura -----------------------------------------------------------


async def test_the_arp_table_answers_first_and_nothing_else_is_asked() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14"]}
    lan.open_hosts = {"192.168.0.14"}
    lan.identities["192.168.0.14"] = ME
    found = await lan.locator().find("192.168.0.11")
    assert (found.host, found.via) == ("192.168.0.14", "arp")  # type: ignore[union-attr]
    assert "ssdp" not in lan.stages()
    assert lan.probed == ["192.168.0.14"]  # só o candidato do ARP, nenhuma varredura


async def test_without_arp_the_ssdp_is_the_second_stage() -> None:
    lan = world()
    lan.ssdp = ["192.168.0.30", "192.168.0.14"]
    lan.identities = {"192.168.0.30": OTHER, "192.168.0.14": ME}
    found = await lan.locator().find("192.168.0.11")
    assert (found.host, found.via) == ("192.168.0.14", "ssdp")  # type: ignore[union-attr]
    assert lan.stages()[:2] == ["arp", "ssdp"]
    assert lan.probed == []


async def test_without_arp_or_ssdp_the_sweep_is_the_last_resort() -> None:
    lan = world()
    lan.open_hosts = {"192.168.0.14"}
    lan.identities["192.168.0.14"] = ME
    found = await lan.locator().find("192.168.0.11")
    assert (found.host, found.via) == ("192.168.0.14", "varredura")  # type: ignore[union-attr]
    assert lan.stages().index("arp") < lan.stages().index("ssdp") < lan.stages().index("identify")


async def test_the_found_tv_teaches_the_record_what_it_was_missing() -> None:
    lan = world()
    lan.ssdp = ["192.168.0.14"]
    lan.identities["192.168.0.14"] = ME
    known = TvKnown(hint=DUID, mac=None)
    found = await lan.locator(known).find("192.168.0.11")
    assert known.mac == MAC
    assert found is not None
    assert found.mac == MAC


# --- confirmar a TV certa --------------------------------------------------------------------


async def test_another_samsung_at_the_candidate_address_is_rejected() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14"]}
    lan.identities["192.168.0.14"] = OTHER  # o IP do MAC mudou de dono (entrada velha do ARP)
    lan.open_hosts = {"192.168.0.14"}
    assert await lan.locator().find("192.168.0.11") is None


async def test_a_mac_in_arp_with_a_silent_tv_is_accepted_when_it_is_the_only_candidate() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14"]}  # a porta atende, mas o REST não responde
    lan.open_hosts = {"192.168.0.14"}
    found = await lan.locator().find("192.168.0.11")
    assert found is not None
    assert (found.host, found.via) == ("192.168.0.14", "arp")


async def test_a_stale_arp_entry_whose_address_does_not_answer_is_never_taken() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14"]}  # entrada velha: o endereço já é de outro aparelho
    lan.open_hosts = set()
    lan.hosts = []
    assert await lan.locator().find("192.168.0.11") is None
    assert not [call for call in lan.calls if call.startswith("identify")]


async def test_a_stale_arp_entry_is_skipped_for_the_one_that_answers() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.20", "192.168.0.14"]}
    lan.open_hosts = {"192.168.0.14"}
    lan.identities["192.168.0.14"] = ME
    found = await lan.locator().find("192.168.0.11")
    assert found is not None
    assert found.host == "192.168.0.14"


async def test_two_silent_arp_candidates_for_one_mac_are_not_guessed() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14", "192.168.0.20"]}
    lan.open_hosts = {"192.168.0.14", "192.168.0.20"}
    lan.identities = {}
    lan.ssdp = []
    assert await lan.locator().find("192.168.0.11") is None


async def test_the_wifi_mac_matches_even_when_only_the_duid_was_saved() -> None:
    lan = world()
    lan.ssdp = ["192.168.0.14"]
    lan.identities["192.168.0.14"] = TvIdentity((DUID,), None)
    assert await lan.locator(TvKnown(hint=DUID.upper())).find("192.168.0.11") is not None


async def test_a_tv_that_is_not_identified_yet_is_never_searched() -> None:
    lan = world()
    assert await lan.locator(TvKnown()).find("192.168.0.11") is None
    assert lan.calls == []


async def test_the_android_hint_that_is_a_mac_is_used_for_the_arp_lookup() -> None:
    lan = world()
    lan.arp = {"AA:BB:CC:00:00:09": ["192.168.0.50"]}
    lan.open_hosts = {"192.168.0.50"}
    lan.identities["192.168.0.50"] = TvIdentity(("AA:BB:CC:00:00:09",), "AA:BB:CC:00:00:09")
    found = await lan.locator(TvKnown(hint="aa-bb-cc-00-00-09")).find("192.168.0.11")
    assert found is not None
    assert found.host == "192.168.0.50"


# --- a TV está onde sempre esteve ------------------------------------------------------------


async def test_arp_showing_the_tv_at_the_old_address_ends_the_search_without_a_sweep() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.11"]}
    assert await lan.locator().find("192.168.0.11") is None
    assert lan.stages() == ["arp"]


# --- limites: SSDP a cada 2 min, varredura a cada 10 min -------------------------------------


async def test_the_sweep_runs_at_most_once_every_ten_minutes() -> None:
    lan = world()
    locator = lan.locator()
    await locator.find("192.168.0.11")
    first_pass = len(lan.probed)
    assert first_pass == len(lan.hosts) - 1  # menos o endereço de sempre

    for _ in range(5):
        lan.clock.advance(60)
        await locator.find("192.168.0.11")
    assert len(lan.probed) == first_pass  # nenhuma varredura nova em 5 minutos

    lan.clock.advance(300)
    await locator.find("192.168.0.11")
    assert len(lan.probed) == 2 * first_pass


async def test_the_ssdp_is_asked_at_most_once_every_two_minutes() -> None:
    lan = world()
    lan.hosts = []
    locator = lan.locator()
    await locator.find("192.168.0.11")
    lan.clock.advance(60)
    await locator.find("192.168.0.11")
    assert lan.stages().count("ssdp") == 1
    lan.clock.advance(61)
    await locator.find("192.168.0.11")
    assert lan.stages().count("ssdp") == 2
    # O ARP, que só lê a tabela, é conferido a cada chamada.
    assert lan.stages().count("arp") == 3


# --- varredura devagar -----------------------------------------------------------------------


async def test_the_sweep_never_has_more_than_sixteen_connections_at_once() -> None:
    lan = world()
    await lan.locator().find("192.168.0.11")
    assert lan.max_in_flight == 16
    assert len(lan.probed) == len(set(lan.probed))  # cada endereço uma vez só


async def test_the_concurrency_is_configurable_and_never_zero() -> None:
    lan = world()
    await lan.locator(concurrency=0).find("192.168.0.11")
    assert lan.max_in_flight == 1


async def test_the_sweep_pauses_between_addresses() -> None:
    lan = world()
    lan.hosts = [f"192.168.0.{number}" for number in range(100, 116)]
    await lan.locator(concurrency=2, spacing_seconds=0.5).find("192.168.0.11")
    # Dois trabalhadores, oito endereços cada, 0,5 s depois de cada um: a varredura leva tempo.
    assert lan.clock.sleeps.count(0.5) == 16
    assert lan.probe_times[-1] >= 3.5


async def test_the_sweep_stops_at_the_first_confirmed_tv() -> None:
    lan = world()
    lan.hosts = [f"192.168.0.{number}" for number in range(100, 200)]
    lan.open_hosts = {"192.168.0.101"}
    lan.identities["192.168.0.101"] = ME
    found = await lan.locator(concurrency=2).find("192.168.0.11")
    assert found is not None
    assert found.host == "192.168.0.101"
    assert len(lan.probed) < 20  # não varreu o resto


async def test_open_ports_of_other_devices_do_not_end_the_sweep() -> None:
    lan = world()
    lan.hosts = ["192.168.0.100", "192.168.0.101", "192.168.0.102"]
    lan.open_hosts = {"192.168.0.100", "192.168.0.101"}
    lan.identities = {"192.168.0.100": OTHER, "192.168.0.102": ME}
    lan.open_hosts.add("192.168.0.102")
    found = await lan.locator(concurrency=1).find("192.168.0.11")
    assert found is not None
    assert found.host == "192.168.0.102"


async def test_the_old_address_is_not_probed_in_the_sweep() -> None:
    lan = world()
    lan.hosts = ["192.168.0.11", "192.168.0.14"]
    await lan.locator().find("192.168.0.11")
    assert lan.probed == ["192.168.0.14"]


async def test_the_sweep_gives_up_at_its_deadline() -> None:
    lan = world()

    async def stuck(host: str) -> bool:
        await asyncio.sleep(60)
        return False

    locator = lan.locator(sweep_deadline_seconds=0.05)
    locator._probe = stuck
    assert await asyncio.wait_for(locator.find("192.168.0.11"), 5) is None


@pytest.mark.parametrize(
    ("hint", "mac", "identity", "expected"),
    [
        (DUID, None, TvIdentity((f"uuid:{DUID}",)), True),
        (None, "74-6d-fa-5d-52-08", TvIdentity((), MAC), True),
        (DUID, MAC, TvIdentity(("outro",), "AA:AA:AA:AA:AA:AA"), False),
    ],
)
def test_matching_ignores_case_prefixes_and_separators(
    hint: str | None, mac: str | None, identity: TvIdentity, expected: bool
) -> None:
    assert TvKnown(hint, mac).matches(identity) is expected


# --- aprender o MAC que o ARP mostra para a TV (TV no cabo) ---------------------------------------


async def test_the_arp_mac_of_the_tv_address_is_learned_when_it_differs() -> None:
    lan = world()
    lan.arp = {"AA:00:00:00:00:01": ["192.168.0.14"], MAC: ["192.168.0.20"]}
    known = TvKnown(hint=DUID, mac=MAC)  # o wifiMac do REST; o cabo tem outro MAC
    assert await lan.locator(known).learn_mac("192.168.0.14") == "AA:00:00:00:00:01"
    assert known.mac == "AA:00:00:00:00:01"


async def test_the_same_or_an_unknown_mac_is_not_news() -> None:
    lan = world()
    lan.arp = {MAC: ["192.168.0.14"]}
    assert await lan.locator(TvKnown(hint=DUID, mac=MAC)).learn_mac("192.168.0.14") is None
    assert await lan.locator(TvKnown(hint=DUID)).learn_mac("192.168.0.99") is None
    assert await lan.locator(TvKnown(hint=DUID)).learn_mac("192.168.0.14") == MAC
