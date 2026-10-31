"""A promoção do ícone para a área visível da barra: uma vez só, sem tocar no registro real."""

from pathlib import Path

import pytest

from uniover_agent.adapters.tray import promote_in_background
from uniover_agent.adapters.tray_registry import FilePromotionMarker, WindowsNotifyIconSettings
from uniover_agent.core.tray_promotion import find_entry, promote_once, same_executable
from uniover_agent.ports.tray import NotifyIconEntry

OWN = r"C:\Users\pessoa\AppData\Local\Programs\Python\Python314\python.exe"


class FakeSettings:
    """O registro de ícones em memória: guarda as linhas e quais chaves foram promovidas."""

    def __init__(self, entries: list[NotifyIconEntry], *, writable: bool = True) -> None:
        self._entries = entries
        self.promoted: list[str] = []
        self._writable = writable

    def entries(self) -> list[NotifyIconEntry]:
        return list(self._entries)

    def promote(self, key: str) -> bool:
        if not self._writable:
            return False
        self.promoted.append(key)
        return True


class MemoryMarker:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def done(self, executable: str) -> bool:
        return executable in self.paths

    def mark(self, executable: str) -> None:
        self.paths.append(executable)


OURS = NotifyIconEntry("111", OWN, "UniOver: conectado - Sala ligada")


def test_promotes_our_icon_once_and_never_again() -> None:
    settings, marker = FakeSettings([OURS]), MemoryMarker()

    assert promote_once(settings, marker, OWN) == "promoted"
    assert promote_once(settings, marker, OWN) == "already_done"
    assert promote_once(settings, marker, OWN) == "already_done"

    assert settings.promoted == ["111"]


def test_a_user_who_hides_the_icon_afterwards_is_not_overridden() -> None:
    """A escolha dele vira `IsPromoted=0`; como a marca existe, o agente nunca escreve de novo."""
    settings, marker = FakeSettings([OURS]), MemoryMarker()
    promote_once(settings, marker, OWN)
    settings.promoted.clear()  # o usuário escondeu: o Windows regrava 0 e nós não mexemos mais

    for _ in range(3):
        assert promote_once(settings, marker, OWN) == "already_done"

    assert settings.promoted == []


def test_without_the_windows_entry_it_waits_and_writes_no_marker() -> None:
    settings, marker = FakeSettings([]), MemoryMarker()

    assert promote_once(settings, marker, OWN) == "not_found"
    assert marker.paths == []


def test_a_failed_write_is_reported_and_leaves_no_marker() -> None:
    settings, marker = FakeSettings([OURS], writable=False), MemoryMarker()

    assert promote_once(settings, marker, OWN) == "failed"
    assert marker.paths == []


def test_other_programs_using_the_same_python_are_left_alone() -> None:
    other = NotifyIconEntry("222", OWN, "Outro programa em Python")
    settings = FakeSettings([other])

    assert find_entry(settings.entries(), OWN) is None
    assert promote_once(settings, MemoryMarker(), OWN) == "not_found"
    assert settings.promoted == []


def test_an_entry_without_a_tooltip_yet_still_matches() -> None:
    assert find_entry([NotifyIconEntry("333", OWN, "")], OWN) is not None


def test_the_path_comparison_ignores_case_and_accepts_known_folder_prefixes() -> None:
    assert same_executable(OWN.upper(), OWN)
    assert same_executable(OWN.replace("\\", "/"), OWN)
    prefixed = r"{6D809377-6AF0-444B-8957-A3773F02200E}\Programs\Python\Python314\python.exe"
    assert not same_executable(prefixed, OWN.replace("AppData\\Local\\Programs", "Outro"))
    assert same_executable(
        r"{6D809377-6AF0-444B-8957-A3773F02200E}\Python\python.exe",
        r"C:\Arquivos\Python\python.exe",
    )
    assert not same_executable("", OWN)


def test_background_wait_retries_until_windows_creates_the_entry() -> None:
    calls = {"count": 0}

    class Late(FakeSettings):
        def entries(self) -> list[NotifyIconEntry]:
            calls["count"] += 1
            return [OURS] if calls["count"] >= 3 else []

    settings, marker = Late([]), MemoryMarker()
    waits: list[float] = []
    records: list[tuple[str, str, str]] = []

    result = promote_in_background(
        settings, marker, OWN, lambda *item: records.append(item), sleep=waits.append, every=3.0
    )

    assert result == "promoted"
    assert waits == [3.0, 3.0]
    assert settings.promoted == ["111"]
    assert records == []


def test_background_wait_gives_up_without_noise_when_the_entry_never_shows() -> None:
    waits: list[float] = []
    records: list[tuple[str, str, str]] = []

    result = promote_in_background(
        FakeSettings([]),
        MemoryMarker(),
        OWN,
        lambda *item: records.append(item),
        sleep=waits.append,
        every=10.0,
        window=30.0,
    )

    assert result == "not_found"
    assert waits == [10.0, 10.0, 10.0]
    assert records == []


def test_background_wait_reports_a_failed_write_to_the_diagnostics() -> None:
    records: list[tuple[str, str, str]] = []

    result = promote_in_background(
        FakeSettings([OURS], writable=False),
        MemoryMarker(),
        OWN,
        lambda *item: records.append(item),
        sleep=lambda _: None,
    )

    assert result == "failed"
    assert [item[:2] for item in records] == [("tray.promote_failed", "error")]


def test_the_marker_survives_a_new_process(tmp_path: Path) -> None:
    path = tmp_path / "runtime" / "tray-promoted.json"

    FilePromotionMarker(path).mark(OWN)

    assert FilePromotionMarker(path).done(OWN)
    assert FilePromotionMarker(path).done(OWN.upper())
    assert not FilePromotionMarker(path).done(r"C:\Outro\python.exe")


def test_a_broken_marker_file_counts_as_not_promoted(tmp_path: Path) -> None:
    path = tmp_path / "tray-promoted.json"
    path.write_text("{ isto nao e json", encoding="utf-8")

    assert not FilePromotionMarker(path).done(OWN)


def test_the_real_registry_adapter_is_inert_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """O adaptador real só roda no Windows; aqui ele devolve o neutro sem abrir chave nenhuma."""
    monkeypatch.setattr("sys.platform", "linux")
    settings = WindowsNotifyIconSettings()

    assert settings.entries() == []
    assert settings.promote("1") is False
