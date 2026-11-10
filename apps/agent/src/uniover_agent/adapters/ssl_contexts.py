"""Contextos TLS reutilizáveis, preparados fora do laço de eventos."""

import asyncio
import ssl
import threading


class SslContexts:
    """Cria cada política TLS uma vez, em uma thread, e a compartilha entre clientes HTTP."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._verified: ssl.SSLContext | None = None

    async def verified(self) -> ssl.SSLContext:
        # Já pronto: sem pular para outra thread a cada pedido.
        if self._verified is not None:
            return self._verified
        return await asyncio.to_thread(self._verified_context)

    def _verified_context(self) -> ssl.SSLContext:
        with self._lock:
            if self._verified is None:
                self._verified = ssl.create_default_context()
            return self._verified


ssl_contexts = SslContexts()
