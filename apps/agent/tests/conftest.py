"""Isolamento: nenhum teste toca na configuração nem no certificado reais do usuário."""

import faulthandler
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from uniover_agent.adapters import crash_trace, local_networks, startup_trace
from uniover_agent.adapters import wol as _wol

# O envio real do pacote mágico (os testes trocam `wol._send`; o do próprio WOL o usa de volta).
REAL_WOL_SEND = _wol._send


@pytest.fixture(autouse=True)
def no_real_scheduling(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nenhum teste muda a prioridade de thread nem o conjunto de trabalho do processo de teste
    (um mínimo duro de memória no pytest, numa máquina com pouca RAM, seria um dano real)."""
    from uniover_agent.adapters import windows_scheduling  # noqa: PLC0415

    monkeypatch.setattr(windows_scheduling, "raise_thread_priority", lambda: True)
    monkeypatch.setattr(windows_scheduling, "protect_working_set", lambda minimum_mb: True)


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nenhum teste fala com a rede local: o teste de vida da TV, a leitura do REST Samsung, o
    ARP, o SSDP e o mDNS são trocados por respostas fixas (os testes que precisam de outra
    resposta a trocam de novo)."""
    from uniover_agent import main as main_module  # noqa: PLC0415
    from uniover_agent.adapters import self_update as self_update_module  # noqa: PLC0415
    from uniover_agent.adapters import (  # noqa: PLC0415
        tv_discovery,
        tv_locate,
        tv_samsung,
        wol,
    )
    from uniover_agent.adapters.tv_discovery import PortState  # noqa: PLC0415
    from uniover_agent.composition import connection as connection_module  # noqa: PLC0415
    from uniover_agent.composition import tv as tv_module  # noqa: PLC0415

    async def alive(host: str, port: int, wait: float = 1.0) -> bool:
        return True

    async def open_probe(host: str, port: int, wait: float = 1.0) -> PortState:
        return PortState.OPEN

    async def api_features(base_url: str, wait_seconds: float = 10.0) -> frozenset[str]:
        return frozenset(
            {
                "agent.diagnostics.v1",
                "tv.pair.v1",
                "tv.state.not_paired",
                "tv.state.waking",
                "tv.presence.v1",
                "tv.settings.open.v1",
            }
        )

    async def no_info(host: str) -> None:
        return None

    async def no_arp() -> dict[str, list[str]]:
        return {}

    async def no_json(url: str) -> None:
        return None

    async def no_ssdp(kind: str, interface: str, wait: float = 0.0) -> list[str]:
        return []

    async def no_mac(host: str) -> None:
        return None

    async def no_identity(kind: str, host: str) -> None:
        return None

    async def no_mdns(listen_seconds: float = 0.0) -> list[object]:
        return []

    monkeypatch.setattr(tv_discovery, "discover_android_tvs", no_mdns)
    monkeypatch.setattr(tv_locate, "tcp_open", alive)
    monkeypatch.setattr(connection_module, "tcp_probe", open_probe)
    monkeypatch.setattr(tv_module, "tcp_probe", open_probe)
    monkeypatch.setattr(main_module, "identify_tv", no_identity)
    # A API dos testes "aceita o diagnóstico e a presença"; os testes do rollout trocam isto por
    # vazio ou `None`.
    monkeypatch.setattr(connection_module, "fetch_api_features", api_features)
    # A trava da identidade vale para a máquina toda: duas execuções dos testes (ou um agente de
    # verdade) com o mesmo slug se recusariam. Os testes dela a pedem direto, com slug próprio.
    monkeypatch.setattr(connection_module, "acquire_slug", lambda agent_id: True)
    monkeypatch.setattr(tv_locate, "http_json", no_json)
    monkeypatch.setattr(tv_locate, "ssdp_search", no_ssdp)
    monkeypatch.setattr(tv_locate, "arp_mac", no_mac)
    monkeypatch.setattr(wol, "_send", lambda mac, host: None)
    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", no_info)
    # A conferência dos arquivos contra o GitHub nunca sai da máquina nos testes (sem ela, a
    # atualização segue só com o zip, como no PC sem acesso à API do GitHub).
    monkeypatch.setattr(self_update_module, "fetch_git_tree", lambda sha: None)
    monkeypatch.setattr("uniover_agent.adapters.tv_samsung_volume.ssdp_locations", lambda host: [])
    monkeypatch.setattr(tv_locate, "arp_table", no_arp)
    # Nenhum teste lista as placas reais do PC (a varredura e a vigia da rede só enxergam o que o
    # teste põe ali): sem isto uma varredura de teste cairia na rede de verdade.
    monkeypatch.setattr(tv_locate, "local_interfaces", lambda: [])
    monkeypatch.setattr(local_networks, "local_interfaces", lambda: [])


@pytest.fixture(autouse=True)
def restore_process_hooks() -> Iterator[None]:
    """O rastro de queda que `run` liga (ganchos e faulthandler) volta ao que o pytest tinha, e o
    `hello` já dado (que encerra a fase de partida) é esquecido."""
    excepthook, threading_hook = sys.excepthook, threading.excepthook
    startup_trace._session["started"] = False  # o `hello` de um teste não vale para o seguinte
    yield
    sys.excepthook, threading.excepthook = excepthook, threading_hook
    startup_trace._session["started"] = False
    faulthandler.disable()
    faulthandler.enable()
    for handle in crash_trace._keep_open:
        handle.close()
    crash_trace._keep_open.clear()


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    for name in (
        "API_URL",
        "AGENT_ID",
        "LOG_LEVEL",
        "ALLOW_INSECURE",
        "TV_HOST",
        "TV_KIND",
        "TV_ID_HINT",
        "TV_MAC",
        "LOG_FILE",
        "TV_CLIENT_NAME",
        "TV_NAME",
        "TV_HIBERNATE_SECONDS",
        "TV_ADB_PORT",
        "ADB_TIMEOUT_SECONDS",
        "ADB_PULL_TIMEOUT_SECONDS",
        "ICONS_DIR",
        "TV_CLEANUP_KEEP",
        "PC_CONTROL",
        "PC_APPS",
        "PC_SHUTDOWN_DELAY_SECONDS",
        "UPDATE_DRILL",
        "UPDATE_SOURCE_URL",
        "UPDATE_CHANNEL",
        "SELF_CARE",
        "HOME",
        "SUPERVISED",
    ):
        monkeypatch.delenv(f"UNIOVER_{name}", raising=False)
    # A pasta do certificado da TV vive em `%LOCALAPPDATA%`: nenhum teste toca na real.
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
    # Nenhum teste roda o `adb` de verdade: o caminho aponta para um arquivo que não existe (uma
    # escolha explícita errada não cai na busca pelo PATH). Os testes do canal ADB trocam isto.
    monkeypatch.setenv("UNIOVER_ADB_PATH", str(tmp_path / "sem-adb" / "adb.exe"))
    # Idem para o `aapt2` (que também não é procurado no SDK real) e o cache de ícones: nenhum
    # teste lê o Android SDK nem grava em `%LOCALAPPDATA%` de verdade.
    monkeypatch.setenv("UNIOVER_AAPT_PATH", str(tmp_path / "sem-aapt" / "aapt2.exe"))
    monkeypatch.setenv("UNIOVER_ICONS_DIR", str(tmp_path / "icones"))
    for sdk_variable in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        monkeypatch.delenv(sdk_variable, raising=False)
    config = tmp_path / "agent.toml"
    monkeypatch.setenv("UNIOVER_CONFIG_FILE", str(config))
    return config


@pytest.fixture(autouse=True)
def restore_root_logging() -> Iterator[None]:
    """`configure_logging` troca os destinos do logger raiz, e cada um escreve numa thread de
    fundo (`OffloadHandler`) no fluxo que o pytest capturava naquele teste. Sem devolver o
    que havia, o destino sobrevive ao teste e escreve num fluxo já fechado."""
    import logging  # noqa: PLC0415

    root = logging.getLogger()
    before = list(root.handlers)
    level = root.level
    yield
    for handler in list(root.handlers):
        if handler not in before:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(level)
