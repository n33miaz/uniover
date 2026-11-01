"""A promoção do ícone para a área visível da barra: uma vez só, sem tocar no registro real."""

import json
import os
from pathlib import Path

import pytest

from uniover_agent.adapters.tray_controller import promote_in_background
from uniover_agent.adapters.tray_registry import FilePromotionMarker, WindowsNotifyIconSettings
from uniover_agent.core.tray_promotion import find_entry, promote_once, same_executable
from uniover_agent.ports.tray import ICON_ID, NotifyIconEntry

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

    def mark(self, executable: str) -> bool:
        self.paths.append(executable)
        return True

    def forget(self, executable: str) -> None:
        self.paths.remove(executable)


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


def test_an_entry_without_a_tooltip_is_never_taken_for_ours() -> None:
    """Outro programa Python com a dica vazia seria promovido no lugar do nosso (só há uma vez)."""
    blank = NotifyIconEntry("333", OWN, "")
    settings, marker = FakeSettings([blank]), MemoryMarker()

    assert find_entry([blank], OWN) is None
    assert promote_once(settings, marker, OWN) == "not_found"
    assert settings.promoted == []
    assert marker.paths == []


def test_an_entry_with_another_icon_id_is_not_ours() -> None:
    foreign = NotifyIconEntry("444", OWN, "UniOver: parece nosso", uid=4242)
    ours = NotifyIconEntry("555", OWN, "UniOver: conectado", uid=ICON_ID)

    assert find_entry([foreign], OWN) is None
    assert find_entry([foreign, ours], OWN) is ours
    # Linha sem UID (versão antiga do Windows) vale pela dica.
    assert find_entry([NotifyIconEntry("666", OWN, "UniOver: conectado")], OWN) is not None


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

    assert FilePromotionMarker(path).mark(OWN) is True

    assert FilePromotionMarker(path).done(OWN)
    assert FilePromotionMarker(path).done(OWN.upper())
    assert not FilePromotionMarker(path).done(r"C:\Outro\python.exe")


def test_no_marker_file_means_never_promoted(tmp_path: Path) -> None:
    assert not FilePromotionMarker(tmp_path / "nao-existe" / "tray-promoted.json").done(OWN)


@pytest.mark.parametrize(
    "content",
    [
        "{ isto nao e json",
        '{"executables": ["C:\\python.exe"',  # gravação cortada no meio por uma queda
        "",
        "[]",
        '{"executables": "nao e lista"}',
        '{"executables": [1, 2]}',
        "\x00\x00\x00",
    ],
)
def test_an_unreadable_marker_is_taken_as_already_promoted(tmp_path: Path, content: str) -> None:
    """Na dúvida não se promove: a pessoa pode ter escondido o ícone depois da primeira vez."""
    path = tmp_path / "tray-promoted.json"
    path.write_text(content, encoding="utf-8")

    assert FilePromotionMarker(path).done(OWN)


def test_an_unreadable_marker_stops_the_promotion_and_is_left_untouched(tmp_path: Path) -> None:
    path = tmp_path / "tray-promoted.json"
    path.write_text("{ cortado", encoding="utf-8")
    settings = FakeSettings([OURS])

    assert promote_once(settings, FilePromotionMarker(path), OWN) == "already_done"

    assert settings.promoted == []
    assert path.read_text(encoding="utf-8") == "{ cortado"
    assert not FilePromotionMarker(path).mark(OWN)


def test_the_marker_is_written_through_a_temporary_file_and_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "tray-promoted.json"
    replaced: list[tuple[str, str]] = []
    real_replace = os.replace

    def spy(source: object, destination: object) -> None:
        # Na hora da troca o destino ainda não existe e o temporário já está inteiro.
        assert json.loads(Path(str(source)).read_text(encoding="utf-8")) == {"executables": [OWN]}
        assert not path.exists()
        replaced.append((Path(str(source)).name, Path(str(destination)).name))
        real_replace(str(source), str(destination))

    monkeypatch.setattr(os, "replace", spy)

    assert FilePromotionMarker(path).mark(OWN)

    assert replaced == [("tray-promoted.json.tmp", "tray-promoted.json")]
    assert not (tmp_path / "tray-promoted.json.tmp").exists()


def test_a_crash_while_writing_leaves_the_old_marker_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "tray-promoted.json"
    FilePromotionMarker(path).mark(r"C:\Antigo\python.exe")

    def dies(source: object, destination: object) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(os, "replace", dies)

    assert FilePromotionMarker(path).mark(OWN) is False

    monkeypatch.undo()
    assert FilePromotionMarker(path).done(r"C:\Antigo\python.exe")
    assert not FilePromotionMarker(path).done(OWN)
    assert not (tmp_path / "tray-promoted.json.tmp").exists()


def test_without_a_writable_marker_the_icon_is_not_promoted(tmp_path: Path) -> None:
    """A marca vem antes da escrita no registro: sem ela gravada, nada é promovido."""

    class Unwritable(MemoryMarker):
        def mark(self, executable: str) -> bool:
            return False

    settings = FakeSettings([OURS])

    assert promote_once(settings, Unwritable(), OWN) == "failed"
    assert settings.promoted == []


def test_the_marker_is_forgotten_when_the_registry_write_fails() -> None:
    settings, marker = FakeSettings([OURS], writable=False), MemoryMarker()

    assert promote_once(settings, marker, OWN) == "failed"

    assert marker.paths == []  # marcada antes e desfeita: dá para tentar de novo


def test_forgetting_keeps_the_other_executables(tmp_path: Path) -> None:
    path = tmp_path / "tray-promoted.json"
    marker = FilePromotionMarker(path)
    marker.mark(OWN)
    marker.mark(r"C:\Outro\python.exe")

    marker.forget(OWN.upper())

    assert not marker.done(OWN)
    assert marker.done(r"C:\Outro\python.exe")


def test_the_real_registry_adapter_is_inert_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """O adaptador real só roda no Windows; aqui ele devolve o neutro sem abrir chave nenhuma."""
    monkeypatch.setattr("sys.platform", "linux")
    settings = WindowsNotifyIconSettings()

    assert settings.entries() == []
    assert settings.promote("1") is False
