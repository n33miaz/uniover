"""Leitura do que a limpeza pergunta à TV: memória, configurações, processos e sucesso."""

import pytest

from uniover_agent.adapters.tv_adb_parsing import (
    AdbOutput,
    command_succeeded,
    parse_component_packages,
    parse_mem_available_mb,
    parse_running_packages,
    parse_setting_value,
)

from .support_adb import NOISE


def test_memavailable_in_kilobytes_becomes_whole_megabytes() -> None:
    assert parse_mem_available_mb("MemAvailable:     262144 kB\r\n") == 256
    assert parse_mem_available_mb(NOISE + "MemAvailable: 1023 kB") == 0
    assert parse_mem_available_mb("MemTotal: 940000 kB\nMemAvailable:  219136 kB\n") == 214


@pytest.mark.parametrize("text", ["", "MemFree:  100 kB", "MemAvailable: muito", "MemAvailable:"])
def test_memavailable_that_cannot_be_read_is_none(text: str) -> None:
    assert parse_mem_available_mb(text) is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("com.exemplo.app/.Main\r\n", "com.exemplo.app/.Main"),
        (NOISE + "valor\r\n", "valor"),
        ("null\r\n", None),
        ("NULL", None),
        ("", None),
        ("\r\n", None),
    ],
)
def test_setting_value_is_the_first_useful_line_and_null_is_none(
    text: str, expected: str | None
) -> None:
    assert parse_setting_value(text) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, set()),
        ("com.exemplo.ime/com.exemplo.ime.Servico", {"com.exemplo.ime"}),
        ("a.b/.One:c.d/.Two:a.b/.Three", {"a.b", "c.d"}),
        # Nada fora do formato de pacote do Android chega adiante.
        ("com.x;reboot/.Main:ok.pkg/.Main", {"ok.pkg"}),
        ("/.SemPacote:semponto/.Main:", set()),
        ("$(id)/.Main", set()),
    ],
)
def test_component_packages_are_validated_one_by_one(value: str | None, expected: set[str]) -> None:
    assert parse_component_packages(value) == frozenset(expected)


def test_running_packages_use_the_last_column_and_fold_secondary_processes() -> None:
    text = (
        "USER      PID  PPID NAME\r\n"
        "root        1     0 init\r\n"
        "root      300     2 [kworker/0:1]\r\n"
        "root      301     1 /system/bin/surfaceflinger\r\n"
        "u0_a40   2345   312 com.cnvs.apptv\r\n"
        "u0_a40   2346   312 com.cnvs.apptv:player\r\n"
        "u0_a41   2400   312 com.spotify.tv.android\r\n"
    )
    assert parse_running_packages(NOISE + text) == {"com.cnvs.apptv", "com.spotify.tv.android"}


def test_a_ps_without_apps_is_an_empty_set() -> None:
    assert parse_running_packages("") == frozenset()
    assert parse_running_packages("error: device offline\r\n") == frozenset()


@pytest.mark.parametrize(
    ("returncode", "text", "expected"),
    [
        (0, "", True),
        (0, NOISE, True),
        (1, "", False),
        (255, "", False),
        (0, "Error: Activity not started\r\n", False),
        (0, "Exception occurred while executing 'force-stop':\r\n", False),
        (0, "java.lang.SecurityException: Permission Denial\r\n", False),
    ],
)
def test_a_command_succeeds_only_with_exit_zero_and_no_error_text(
    returncode: int, text: str, expected: bool
) -> None:
    assert command_succeeded(AdbOutput(returncode, text)) is expected
