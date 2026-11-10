import asyncio
import ssl

import pytest

from uniover_agent.adapters.ssl_contexts import SslContexts


async def test_verified_context_is_created_once_and_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    made = 0
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    def create() -> ssl.SSLContext:
        nonlocal made
        made += 1
        return context

    monkeypatch.setattr(ssl, "create_default_context", create)
    contexts = SslContexts()

    first, second = await asyncio.gather(contexts.verified(), contexts.verified())

    assert made == 1
    assert first is second is context
