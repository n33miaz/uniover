"""Isolamento: nenhum teste toca na configuração nem no certificado reais do usuário."""

from pathlib import Path

import pytest

from uniover_agent.adapters import wol as _wol

# O envio real do pacote mágico (os testes trocam `wol._send`; o do próprio WOL o usa de volta).
REAL_WOL_SEND = _wol._send


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nenhum teste fala com a rede local: o teste de vida da TV, a leitura do REST Samsung, o
    ARP e o SSDP são trocados por respostas fixas (os testes que precisam de outra resposta a
    trocam de novo)."""
    from uniover_agent import main as main_module  # noqa: PLC0415
    from uniover_agent.adapters import tv_locate, tv_samsung, wol  # noqa: PLC0415

    async def alive(host: str, port: int, wait: float = 1.0) -> bool:
        return True

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

    monkeypatch.setattr(tv_locate, "tcp_open", alive)
    monkeypatch.setattr(main_module, "tcp_open", alive)
    monkeypatch.setattr(main_module, "identify_tv", no_identity)
    monkeypatch.setattr(tv_locate, "http_json", no_json)
    monkeypatch.setattr(tv_locate, "ssdp_search", no_ssdp)
    monkeypatch.setattr(tv_locate, "arp_mac", no_mac)
    monkeypatch.setattr(wol, "_send", lambda mac, host: None)
    monkeypatch.setattr(tv_samsung, "fetch_samsung_info", no_info)
    monkeypatch.setattr("uniover_agent.adapters.tv_samsung_volume.ssdp_locations", lambda host: [])
    monkeypatch.setattr(tv_locate, "arp_table", no_arp)


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
        "UPDATE_DRILL",
        "UPDATE_SOURCE_URL",
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
