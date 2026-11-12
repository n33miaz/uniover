"""Portas (Protocol) que o núcleo usa; adaptadores as implementam."""

from datetime import datetime
from typing import Protocol

from uniover_agent.ports.app_icons import (
    ApkInspector,
    ApkScratch,
    ApkSource,
    AppIcon,
    CachedIcon,
    IconCache,
    IconToolError,
)
from uniover_agent.ports.network_change import NetworkChangeWatcher, NetworkChangeWatcherFactory
from uniover_agent.ports.pairing import (
    PairingClient,
    PairingDenied,
    PairingError,
    PairingExpired,
    PairingInfo,
    PairingNotFound,
    PairingRateLimited,
    PairingTicket,
    PairingUnavailable,
    PollApproved,
    PollPending,
    PollResult,
    PollSlowDown,
)
from uniover_agent.ports.pc import (
    PcAudio,
    PcInput,
    PcInputRefused,
    PcLauncher,
    PcPower,
    PcUnsupported,
    VolumeState,
)
from uniover_agent.ports.pc_direct import (
    INPUT_CHANNEL,
    POINTER_CHANNEL,
    DirectPeer,
    DirectPeerFactory,
    DirectUnavailable,
    PeerCallbacks,
)
from uniover_agent.ports.pc_lane import LaneHost
from uniover_agent.ports.transport import (
    ConnectionReplaced,
    CredentialRejected,
    HandoverRequested,
    HandoverUnsupported,
    Sender,
    ServerRestarting,
    ServerRestartNow,
    Transport,
    TransportError,
)
from uniover_agent.ports.tv_adb import (
    ADB_USER_INITIATED,
    AdbCommandFailed,
    AdbDeviceChanged,
    AdbError,
    AdbIdentityUnconfirmed,
    AdbIdle,
    AdbNotReady,
    AdbPermissionSink,
    AdbPermissionState,
    AdbTimeout,
    AdbUnauthorized,
    AdbUnavailable,
    AdbUnreachable,
    LaunchableApp,
    TvAdb,
    UserRequest,
    adb_text_groups,
    current_user_request,
    is_adb_typable,
    is_user_initiated,
    user_initiated_adb,
)
from uniover_agent.ports.tv_channel import (
    TvCertificateRefused,
    TvChannel,
    TvChannelError,
    TvNotPaired,
    TvPairingFailed,
    TvPermissionNeeded,
    TvPortClosed,
    TvUnreachable,
)
from uniover_agent.ports.tv_cleanup import CleanupDayStore, TvAdbCleanup, WakeSettings
from uniover_agent.ports.tv_driver import TextFieldStatus, TvDriver
from uniover_agent.ports.tv_remote import TvRemote


class Clock(Protocol):
    def now(self) -> datetime: ...

    def monotonic(self) -> float:
        """Relógio monotônico em segundos, para medir estabilidade da conexão."""
        ...

    async def sleep(self, seconds: float) -> None: ...


class SecretStore(Protocol):
    """Guarda segredos por nome (aqui, o token de dispositivo por `agentId`)."""

    def get(self, name: str) -> str | None: ...

    def set(self, name: str, value: str) -> None: ...

    def delete(self, name: str) -> None: ...


__all__ = [
    "ADB_USER_INITIATED",
    "INPUT_CHANNEL",
    "POINTER_CHANNEL",
    "AdbCommandFailed",
    "AdbDeviceChanged",
    "AdbError",
    "AdbIdentityUnconfirmed",
    "AdbIdle",
    "AdbNotReady",
    "AdbPermissionSink",
    "AdbPermissionState",
    "AdbTimeout",
    "AdbUnauthorized",
    "AdbUnavailable",
    "AdbUnreachable",
    "ApkInspector",
    "ApkScratch",
    "ApkSource",
    "AppIcon",
    "CachedIcon",
    "CleanupDayStore",
    "Clock",
    "ConnectionReplaced",
    "CredentialRejected",
    "DirectPeer",
    "DirectPeerFactory",
    "DirectUnavailable",
    "HandoverRequested",
    "HandoverUnsupported",
    "IconCache",
    "IconToolError",
    "LaneHost",
    "LaunchableApp",
    "NetworkChangeWatcher",
    "NetworkChangeWatcherFactory",
    "PairingClient",
    "PairingDenied",
    "PairingError",
    "PairingExpired",
    "PairingInfo",
    "PairingNotFound",
    "PairingRateLimited",
    "PairingTicket",
    "PairingUnavailable",
    "PcAudio",
    "PcInput",
    "PcInputRefused",
    "PcLauncher",
    "PcPower",
    "PcUnsupported",
    "PeerCallbacks",
    "PollApproved",
    "PollPending",
    "PollResult",
    "PollSlowDown",
    "SecretStore",
    "Sender",
    "ServerRestartNow",
    "ServerRestarting",
    "TextFieldStatus",
    "Transport",
    "TransportError",
    "TvAdb",
    "TvAdbCleanup",
    "TvCertificateRefused",
    "TvChannel",
    "TvChannelError",
    "TvDriver",
    "TvNotPaired",
    "TvPairingFailed",
    "TvPermissionNeeded",
    "TvPortClosed",
    "TvRemote",
    "TvUnreachable",
    "UserRequest",
    "VolumeState",
    "WakeSettings",
    "adb_text_groups",
    "current_user_request",
    "is_adb_typable",
    "is_user_initiated",
    "user_initiated_adb",
]
