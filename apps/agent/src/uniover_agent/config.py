"""Configuração do agente: variáveis `UNIOVER_*` e o arquivo local fora do repositório.

Nenhum segredo passa por aqui: o token de dispositivo vive só no cofre do sistema.
"""

import ipaddress
import logging
import os
import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

CONFIG_FILE_ENV = "UNIOVER_CONFIG_FILE"

_log = logging.getLogger(__name__)


class ConfigError(Exception):
    """Configuração ausente ou insegura; a mensagem já é para o usuário."""


def _local_base() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) if local else Path.home() / ".config"


def default_config_path() -> Path:
    """`%LOCALAPPDATA%\\UniOver\\agent.toml` no Windows; `~/.config/UniOver/agent.toml` no resto."""
    return _local_base() / "UniOver" / "agent.toml"


def tv_cert_dir(tv_name: str) -> Path:
    """Pasta do par certificado/chave da TV: fora do repositório, por usuário e por TV."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", tv_name).strip(".-")[:40] or "tv"
    return _local_base() / "UniOver" / "tv" / safe


def config_path() -> Path:
    override = os.environ.get(CONFIG_FILE_ENV)
    return Path(override) if override else default_config_path()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="UNIOVER_", extra="ignore")

    api_url: str | None = None
    agent_id: str | None = None
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    allow_insecure: bool = False
    # TV (Remote v2). O IP não é garantidamente fixo, por isso vem de configuração.
    tv_host: str | None = None
    # Nome do agente que aparece na TV durante o pareamento.
    tv_client_name: str = "UniOver"
    # Nome da pasta do certificado desta TV, em `%LOCALAPPDATA%\UniOver\tv\<nome>`.
    tv_name: str = "tv"
    # Sem comando e sem aviso de "app aberto" por este tempo, a sessão com a TV hiberna.
    tv_hibernate_seconds: int = Field(default=300, ge=1)
    # ADB: caminho do `adb` (padrão: procura no PATH e no Android SDK), porta e tempo por comando.
    adb_path: str | None = None
    tv_adb_port: int = Field(default=5555, ge=1, le=65535)
    adb_timeout_seconds: float = Field(default=5.0, gt=0)

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
