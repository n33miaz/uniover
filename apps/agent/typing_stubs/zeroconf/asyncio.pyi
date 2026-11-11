from collections.abc import Callable, Sequence

from zeroconf import IPVersion, ServiceStateChange, Zeroconf

ServiceStateHandler = Callable[[Zeroconf, str, str, ServiceStateChange], None]

class AsyncZeroconf:
    zeroconf: Zeroconf

    def __init__(self, *, ip_version: IPVersion) -> None: ...
    async def async_close(self) -> None: ...

class AsyncServiceBrowser:
    def __init__(
        self,
        zeroconf: Zeroconf,
        type_: str,
        *,
        handlers: Sequence[ServiceStateHandler],
    ) -> None: ...
    async def async_cancel(self) -> None: ...

class AsyncServiceInfo:
    def __init__(self, type_: str, name: str) -> None: ...
    async def async_request(self, zeroconf: Zeroconf, timeout: int) -> bool: ...  # noqa: ASYNC109
    def parsed_addresses(self, version: IPVersion) -> list[str]: ...
