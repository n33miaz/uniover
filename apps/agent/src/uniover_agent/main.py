import logging

from uniover_agent.adapters.fakes import FakeClock, FakeTvRemote
from uniover_agent.config import Settings
from uniover_agent.core import HandleCommand, tv_key_handler

_log = logging.getLogger("uniover_agent")


def build() -> HandleCommand:
    """Composição: por enquanto só com fakes; adaptadores reais entram depois."""
    return HandleCommand({"tv.key.v1": tv_key_handler(FakeTvRemote())}, FakeClock())


def main() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level)
    build()
    _log.info("pronto (agente %s, api %s)", settings.agent_id, settings.api_url)
