"""Configuração do agente: variáveis `UNIOVER_*` e o arquivo local fora do repositório.

Nenhum segredo passa por aqui: o token de dispositivo vive só no cofre do sistema.
"""

import ipaddress
import logging
import os
import re
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.self_update import CHANNELS, DEFAULT_CHANNEL
from uniover_agent.adapters.tv_adb_parsing import is_valid_package

CONFIG_FILE_ENV = "UNIOVER_CONFIG_FILE"

_log = logging.getLogger(__name__)


class ConfigError(Exception):
    """Configuração ausente ou insegura; a mensagem já é para o usuário."""


def default_config_path() -> Path:
    """Arquivo de configuração na pasta organizada da instalação."""
    return installation_base() / "config" / "agent.toml"


def connection_page_path() -> Path:
    """Página local do QR do pareamento: ao lado do arquivo de configuração em uso."""
    config = config_path()
    if config.parent.name == "config":
        return config.parent.parent / "web" / "conectar.html"
    # Overrides de desenvolvimento e wrappers antigos continuam tendo a página ao lado do TOML.
    return config.parent / "conectar.html"


def tv_cert_dir(tv_name: str) -> Path:
    """Pasta do par certificado/chave da TV: fora do repositório, por usuário e por TV."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", tv_name).strip(".-")[:40] or "tv"
    return installation_base() / "tv" / safe


def agent_source_dir() -> Path:
    """Onde o instalador põe o código do agente (e onde a auto-atualização o troca)."""
    return installation_base() / "app"


def config_path() -> Path:
    override = os.environ.get(CONFIG_FILE_ENV)
    return Path(override) if override else default_config_path()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="UNIOVER_", extra="ignore")

    api_url: str | None = None
    agent_id: str | None = None
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    allow_insecure: bool = False
    # Arquivo de registro com rodízio. O instalador aponta para
    # `%LOCALAPPDATA%\UniOver\logs\agent.log`,
    # pois a tarefa roda sem janela). Vazio: só o terminal.
    log_file: str | None = None
    # TV. O IP não é garantidamente fixo, por isso vem de configuração.
    tv_kind: Literal["android", "samsung"] = "android"
    tv_host: str | None = None
    # Identificador estável da TV (Samsung: `duid` ou MAC Wi-Fi; Android: MAC). Serve para
    # reencontrá-la na rede se o IP mudar; o `tv-find` grava.
    tv_id_hint: str | None = None
    # MAC da TV (Wi-Fi). Reencontra a TV pela tabela ARP quando o IP muda e serve ao
    # Wake-on-LAN. Gravado pelo `tv-find`, pelo pareamento e na primeira conexão.
    tv_mac: str | None = None
    # Nome do agente que aparece na TV durante o pareamento.
    tv_client_name: str = "UniOver"
    # Nome da pasta do certificado desta TV, em `%LOCALAPPDATA%\UniOver\tv\<nome>`.
    tv_name: str = "tv"
    # Apps Tizen extras a consultar no endpoint REST da Samsung; a TV só publica os instalados.
    tv_samsung_apps: Annotated[list[str], NoDecode] = Field(default_factory=list)
    # Sem comando e sem aviso de "app aberto" por este tempo, a sessão com a TV hiberna.
    tv_hibernate_seconds: int = Field(default=300, ge=1)
    # Desligar com leitura (`tv.power.off.v1`): quanto esperar a leitura de energia antes da tecla e
    # a confirmação depois dela. Sem leitura ou sem confirmação a tecla não é repetida (uma segunda
    # tecla pode religar a TV). Valores iniciais, a ajustar depois de medir na TV real.
    tv_power_off_read_timeout_seconds: float = Field(default=2.0, gt=0, le=30)
    tv_power_off_confirmation_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # Digitação: o acréscimo feito só de letras minúsculas, dígitos, espaço e `. , - /` vai por
    # teclas do controle remoto (um pacote por caractere, sem o processo `adb` de cada trecho).
    # Desligado por padrão: foi desenhado sem poder testar na TV real. `tv_text_key_pause_ms` põe
    # uma pausa entre as teclas, para o caso de a TV perder letras quando elas chegam coladas.
    tv_text_by_keys: bool = False
    tv_text_key_pause_ms: int = Field(default=0, ge=0, le=500)
    # Vigia do serviço do controle da Android TV: religa por ADB quando as portas 6466/6467 fecham.
    # Só age com `adb` neste PC; desligue se outra coisa (o vigia antigo do PC) já faz isso.
    tv_watchdog: bool = True
    # ADB: caminho do `adb` (padrão: procura no PATH e no Android SDK), porta e tempo por comando.
    adb_path: str | None = None
    tv_adb_port: int = Field(default=5555, ge=1, le=65535)
    adb_timeout_seconds: float = Field(default=5.0, gt=0)
    # Tempo para copiar um APK da TV (bem maior que o de um comando curto).
    adb_pull_timeout_seconds: float = Field(default=120.0, gt=0)
    # Ícones dos apps: `aapt2` do Android SDK (padrão: o mais novo em `build-tools`; sem ele, sem
    # ícones) e a pasta do cache (padrão: `%LOCALAPPDATA%\UniOver\icons`).
    aapt_path: str | None = None
    icons_dir: str | None = None
    # De que ramo do repositório o agente se atualiza (`develop` hoje; `main` quando a publicação
    # voltar).
    update_channel: str = DEFAULT_CHANNEL
    # Auto-diagnóstico periódico com reparo seguro e envio das ocorrências à API. Desligue só para
    # depurar.
    self_care: bool = True
    # TV Livre (launcher próprio da TV Android): sempre opt-in por comando do dono; esta chave só
    # decide se o agente oferece o módulo. O APK vem da publicação, conferido pelo hash e pela
    # assinatura Android v2/v3 fixada no agente.
    tv_livre: bool = True
    tv_livre_apk_url: str = "https://github.com/n33miaz/uniover/releases/latest/download"
    # Limpeza da TV: pacotes que nunca são fechados, além dos protegidos de fábrica. Na variável de
    # ambiente, separados por vírgula; no arquivo, uma lista TOML ou o mesmo texto. Sem `NoDecode` o
    # pydantic-settings exigiria JSON na variável.
    tv_cleanup_keep: Annotated[list[str], NoDecode] = Field(default_factory=list)

    @field_validator("update_channel")
    @classmethod
    def _validate_update_channel(cls, value: str) -> str:
        channel = value.strip().lower()
        if channel not in CHANNELS:
            raise ValueError("update_channel precisa ser main ou develop")
        return channel

    @field_validator("tv_cleanup_keep", mode="before")
    @classmethod
    def _split_cleanup_keep(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("tv_samsung_apps", mode="before")
    @classmethod
    def _split_samsung_apps(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("tv_samsung_apps")
    @classmethod
    def _validate_samsung_apps(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", app_id) for app_id in value):
            raise ValueError("tv_samsung_apps precisa conter IDs Tizen separados por vírgula")
        return list(dict.fromkeys(value))

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # Ordem de precedência: argumentos > variáveis de ambiente > arquivo local do usuário.
        return (init_settings, env_settings, TomlConfigSettingsSource(settings_cls, config_path()))


_HOSTNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


def require_tv_host(host: str | None) -> str:
    """Endereço da TV (IP ou nome), sem esquema, porta ou espaços."""
    if not host:
        raise ConfigError("defina UNIOVER_TV_HOST (endereço IP da TV)")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not _HOSTNAME_PATTERN.fullmatch(host):
            raise ConfigError(
                "UNIOVER_TV_HOST precisa ser só o IP ou o nome da TV, sem http:// nem porta"
            ) from None
    return host


def require_cleanup_keep(settings: Settings) -> frozenset[str]:
    """Pacotes que o dono pediu para a limpeza da TV nunca fechar, já validados."""
    for package in settings.tv_cleanup_keep:
        if not is_valid_package(package):
            raise ConfigError(
                "UNIOVER_TV_CLEANUP_KEEP precisa ser uma lista de nomes de pacote do Android "
                "separados por vírgula (por exemplo com.exemplo.app); um dos itens não é"
            )
    return frozenset(settings.tv_cleanup_keep)


def require_api_url(settings: Settings) -> str:
    """Devolve a URL base: `https://` sempre; `http://` só com `UNIOVER_ALLOW_INSECURE=1`."""
    url = settings.api_url
    if not url:
        raise ConfigError("defina UNIOVER_API_URL (endereço https da API)")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ConfigError("UNIOVER_API_URL precisa ser um endereço http(s) completo")
    if parts.scheme == "http":
        if not settings.allow_insecure:
            raise ConfigError(
                "UNIOVER_API_URL precisa ser https (http só em desenvolvimento, "
                "com UNIOVER_ALLOW_INSECURE=1)"
            )
        _log.warning(
            "conexão sem criptografia liberada por UNIOVER_ALLOW_INSECURE; só para desenvolvimento"
        )
    return url.rstrip("/")
