"""O dia da limpeza no disco: gravação atômica e leitura que nunca levanta erro."""

import errno
import os
from datetime import date
from pathlib import Path

import pytest

from uniover_agent.adapters.cleanup_day_file import CLEANUP_DAY_FILE, CleanupDayFile

DAY = date(2026, 11, 5)


def test_a_saved_day_is_read_back_by_a_new_instance(tmp_path: Path) -> None:
    CleanupDayFile(tmp_path).save(DAY)

    assert CleanupDayFile(tmp_path).load() == DAY


def test_the_runtime_folder_is_created_on_the_first_save(tmp_path: Path) -> None:
    runtime = tmp_path / "ainda" / "nao" / "existe"

    CleanupDayFile(runtime).save(DAY)

    assert (runtime / CLEANUP_DAY_FILE).is_file()


def test_there_is_nothing_to_read_before_the_first_save(tmp_path: Path) -> None:
    assert CleanupDayFile(tmp_path).load() is None


def test_saving_again_replaces_the_day_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    store = CleanupDayFile(tmp_path)
    store.save(DAY)
    store.save(date(2026, 11, 6))

    assert store.load() == date(2026, 11, 6)
    assert sorted(path.name for path in tmp_path.iterdir()) == [CLEANUP_DAY_FILE]


@pytest.mark.parametrize(
    "content",
    [
        b"",
        b"isto nao e json",
        b"\xff\xfe\x00\x80",  # nem texto
        b"[]",
        b"null",
        b'{"light": 20261105}',
        b'{"light": "ontem"}',
        b'{"light": "2026-13-45"}',
        b'{"outra": "2026-11-05"}',
        b'{"light": "2026-11-05", "lixo": "' + b"x" * 5000 + b'"}',  # grande demais
    ],
)
def test_a_corrupt_file_means_the_cleanup_did_not_run_yet(tmp_path: Path, content: bytes) -> None:
    (tmp_path / CLEANUP_DAY_FILE).write_bytes(content)

    assert CleanupDayFile(tmp_path).load() is None


def test_a_file_written_with_a_byte_order_mark_is_still_read(tmp_path: Path) -> None:
    (tmp_path / CLEANUP_DAY_FILE).write_bytes(b'\xef\xbb\xbf{"light": "2026-11-05"}')

    assert CleanupDayFile(tmp_path).load() == DAY


def test_a_full_disk_does_not_raise_and_keeps_the_previous_day(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = CleanupDayFile(tmp_path)
    store.save(DAY)

    def disk_full(self: Path, *args: object, **kwargs: object) -> int:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(Path, "write_text", disk_full)
    store.save(date(2026, 11, 6))  # não levanta

    monkeypatch.undo()
    assert store.load() == DAY, "a gravação falhou antes da troca: o arquivo anterior segue inteiro"
    assert sorted(path.name for path in tmp_path.iterdir()) == [CLEANUP_DAY_FILE]


def test_a_failed_swap_does_not_raise_and_cleans_the_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = CleanupDayFile(tmp_path)
    store.save(DAY)

    def locked(source: object, target: object) -> None:
        raise PermissionError(errno.EACCES, "arquivo preso por outro programa")

    monkeypatch.setattr(os, "replace", locked)
    store.save(date(2026, 11, 6))  # não levanta

    monkeypatch.undo()
    assert store.load() == DAY
    assert sorted(path.name for path in tmp_path.iterdir()) == [CLEANUP_DAY_FILE]


def test_an_unwritable_folder_does_not_raise(tmp_path: Path) -> None:
    blocker = tmp_path / "arquivo"
    blocker.write_text("não é pasta")

    CleanupDayFile(blocker / "runtime").save(DAY)  # a pasta não pode ser criada

    assert CleanupDayFile(blocker / "runtime").load() is None
