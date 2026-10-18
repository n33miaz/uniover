from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="UNIOVER_", extra="ignore")

    api_url: str = "http://localhost:5000"
    agent_id: str = "pc-casa"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
