"""Casos de uso, sem rede nem biblioteca de aparelho."""

from uniover_agent.core.connection import (
    REVOKED_MESSAGE,
    Backoff,
    BackoffPolicy,
    ConnectionSupervisor,
)
from uniover_agent.core.domain import Command, CommandResult, ResultStatus, TvState
from uniover_agent.core.envelope_gate import Accepted, EnvelopeGate, GateResult, Rejected
from uniover_agent.core.envelopes import INVALID_MESSAGE, EnvelopeFactory
from uniover_agent.core.handle_command import HandleCommand, Handler
from uniover_agent.core.pair_agent import PairAgent, PairedAgent
from uniover_agent.core.process_message import ProcessMessage
from uniover_agent.core.tv import (
    DEFAULT_LINK_SCHEMES,
    POWER_KEYS,
    TV_NOT_PAIRED,
    TV_UNREACHABLE,
    SessionState,
    TvControl,
    TvSessionError,
    TvSessionManager,
    TvStatePublisher,
    tv_app_launch_handler,
    tv_key_handler,
    tv_wake_handler,
)

__all__ = [
    "DEFAULT_LINK_SCHEMES",
    "INVALID_MESSAGE",
    "POWER_KEYS",
    "REVOKED_MESSAGE",
    "TV_NOT_PAIRED",
    "TV_UNREACHABLE",
    "Accepted",
    "Backoff",
    "BackoffPolicy",
    "Command",
    "CommandResult",
    "ConnectionSupervisor",
    "EnvelopeFactory",
    "EnvelopeGate",
    "GateResult",
    "HandleCommand",
    "Handler",
    "PairAgent",
    "PairedAgent",
    "ProcessMessage",
    "Rejected",
    "ResultStatus",
    "SessionState",
    "TvControl",
    "TvSessionError",
    "TvSessionManager",
    "TvState",
    "TvStatePublisher",
    "tv_app_launch_handler",
    "tv_key_handler",
    "tv_wake_handler",
]
