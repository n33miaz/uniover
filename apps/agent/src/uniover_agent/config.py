"""Configuração do agente: variáveis `UNIOVER_*` e o arquivo local fora do repositório.

Nenhum segredo passa por aqui: o token de dispositivo vive só no cofre do sistema.
"""

import logging
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

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


def default_config_path() -> Path:
    """`%LOCALAPPDATA%\\UniOver\\agent.toml` no Windows; `~/.config/UniOver/agent.toml` no resto."""
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) if local else Path.home() / ".config"
    return base / "UniOver" / "agent.toml"


def config_path() -> Path:
    override = os.environ.get(CONFIG_FILE_ENV)
    return Path(override) if override else default_config_path()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="UNIOVER_", extra="ignore")

    api_url: str | None = None
    agent_id: str | None = None
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    allow_insecure: bool = False

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
