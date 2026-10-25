"""Nenhum console aparece (processos sempre sem janela) e a tabela ARP lida sem processo."""

import asyncio
import os
import re
import socket
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from uniover_agent.adapters import arp as arp_module
from uniover_agent.adapters import installation, process, tv_pairing
from uniover_agent.adapters.arp import arp_mac, parse_arp_table, parse_ip_net_table
from uniover_agent.adapters.process import (
    NO_WINDOW,
    exec_hidden,
    hidden_flags,
    popen_hidden,
    run_hidden,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "uniover_agent"


def test_the_flag_is_create_no_window_on_windows() -> None:
    if os.name == "nt":
        assert NO_WINDOW == subprocess.CREATE_NO_WINDOW == 0x08000000
    else:
        assert NO_WINDOW == 0
    assert hidden_flags() == NO_WINDOW


def test_caller_flags_are_kept_next_to_the_no_window_flag() -> None:
    assert hidden_flags(0x200) == NO_WINDOW | 0x200


def test_run_hidden_adds_the_flag_and_forbids_a_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.update(kwargs)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake)
    run_hidden(["x"], timeout=3, creationflags=0x200)
    assert seen["creationflags"] == NO_WINDOW | 0x200
    assert seen["check"] is False
    run_hidden(["x"], check=True)
    assert seen["check"] is True
    with pytest.raises(ValueError, match="shell"):
        run_hidden(["x"], shell=True)  # noqa: S604 - o ajudante tem de recusar


def test_popen_hidden_adds_the_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake(args: list[str], **kwargs: Any) -> None:
        seen.update(kwargs)

    monkeypatch.setattr(subprocess, "Popen", fake)
    popen_hidden(["x"])
    assert seen["creationflags"] == NO_WINDOW
    with pytest.raises(ValueError, match="shell"):
        popen_hidden(["x"], shell=True)  # noqa: S604 - o ajudante tem de recusar


async def test_exec_hidden_adds_the_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def fake(*args: str, **kwargs: Any) -> None:
        seen.update(kwargs, args=args)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake)
    await exec_hidden("arp", "-an")
    assert seen["creationflags"] == NO_WINDOW
    assert seen["args"] == ("arp", "-an")


def test_a_real_child_process_runs_through_the_helper() -> None:
    done = run_hidden([sys.executable, "-c", "print('ok')"], capture_output=True, text=True)
    assert done.stdout.strip() == "ok"


def test_only_the_helper_creates_processes() -> None:
    """Todo `subprocess` do agente passa pelo ajudante: nenhum módulo chama o sistema direto."""
    direct = re.compile(
        r"subprocess\.(run|Popen|call|check_call|check_output)\(|create_subprocess_(exec|shell)\("
        r"|os\.(system|popen)\(|shell\s*=\s*True"
    )
    offenders = []
    for path in SRC.rglob("*.py"):
        if path.name == "process.py" or "contracts" in path.parts:
            continue
        if direct.search(path.read_text(encoding="utf-8")):
            offenders.append(path.name)
    assert offenders == []


def test_the_modules_that_start_processes_use_the_helper() -> None:
    assert vars(installation)["run_hidden"] is process.run_hidden
    assert vars(installation)["popen_hidden"] is process.popen_hidden
    assert vars(tv_pairing)["run_hidden"] is process.run_hidden


def test_the_powershell_fallback_launch_in_installation_is_hidden_and_not_detached(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kwargs: seen.update(kwargs))
    root = tmp_path / "UniOver"
    for name in ("launcher.ps1", "run-agent.ps1"):
        (root / "app" / "tools").mkdir(parents=True, exist_ok=True)
        (root / "app" / "tools" / name).write_text("# x", encoding="utf-8")
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    monkeypatch.setenv("UNIOVER_LEGACY_TAKEOVER", "0")  # a função o liga; o teste desfaz
    # Com o Script Host funcionando o lançador sobe por ele; este teste cobre o caminho de reserva.
    monkeypatch.setattr(installation, "_windows_script_host_works", lambda _root: False)
    installation._install_launcher(root, start_now=True)
    if os.name == "nt":
        assert seen["creationflags"] & subprocess.CREATE_NO_WINDOW
        assert not seen["creationflags"] & subprocess.DETACHED_PROCESS


# --- ARP -----------------------------------------------------------------------------------------


def row(ip: str, mac: bytes, kind: int = 3, length: int = 6) -> bytes:
    return struct.pack("<II8s4sI", 7, length, mac.ljust(8, b"\x00"), socket.inet_aton(ip), kind)


def table(*rows: bytes) -> bytes:
    return struct.pack("<I", len(rows)) + b"".join(rows)


def test_the_native_table_is_decoded() -> None:
    raw = table(
        row("192.168.0.14", bytes.fromhex("746dfa5d5208")),
        row("192.168.0.1", bytes.fromhex("aabbccddeeff")),
        row("224.0.0.22", bytes.fromhex("01005e000016"), kind=4),
        row("192.168.0.255", bytes.fromhex("ffffffffffff"), kind=4),
        row("192.168.0.99", bytes.fromhex("112233445566"), kind=2),  # incompleta
        row("192.168.0.98", bytes.fromhex("112233445577"), length=0),
    )
    assert parse_ip_net_table(raw) == {
        "74:6D:FA:5D:52:08": ["192.168.0.14"],
        "AA:BB:CC:DD:EE:FF": ["192.168.0.1"],
    }


def test_the_native_table_survives_garbage() -> None:
    assert parse_ip_net_table(b"") == {}
    assert parse_ip_net_table(struct.pack("<I", 5)) == {}
    assert parse_ip_net_table(struct.pack("<I", 3) + b"\x00" * 10) == {}


def test_two_addresses_of_one_mac_are_both_kept_without_repeats() -> None:
    mac = bytes.fromhex("746dfa5d5208")
    raw = table(row("192.168.0.11", mac), row("192.168.0.14", mac), row("192.168.0.14", mac))
    assert parse_ip_net_table(raw) == {"74:6D:FA:5D:52:08": ["192.168.0.11", "192.168.0.14"]}


def test_the_text_table_serves_windows_and_unix_formats() -> None:
    text = (
        "Interface: 192.168.0.12 --- 0x12\n"
        "  Endereço IP           Endereço físico       Tipo\n"
        "  192.168.0.14          74-6d-fa-5d-52-08     dinâmico\n"
        "  255.255.255.255       ff-ff-ff-ff-ff-ff     estático\n"
        "? (192.168.0.20) at 74:6d:fa:00:00:01 [ether] on en0\n"
    )
    assert parse_arp_table(text) == {
        "74:6D:FA:5D:52:08": ["192.168.0.14"],
        "74:6D:FA:00:00:01": ["192.168.0.20"],
    }


async def test_arp_mac_finds_the_address_in_the_table(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_table() -> dict[str, list[str]]:
        return {"AA:BB:CC:00:00:09": ["192.168.0.40"]}

    monkeypatch.setattr(arp_module, "arp_table", fake_table)
    assert await arp_mac("192.168.0.40") == "AA:BB:CC:00:00:09"
    assert await arp_mac("192.168.0.41") is None


@pytest.mark.skipif(sys.platform != "win32", reason="GetIpNetTable só existe no Windows")
async def test_the_real_windows_table_is_readable_without_a_process() -> None:
    # Só lê a tabela do próprio Windows (nenhum pacote sai); o conteúdo depende da máquina.
    result = await arp_module.arp_table()
    assert isinstance(result, dict)
    for mac, hosts in result.items():
        assert re.fullmatch(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", mac)
        assert hosts
