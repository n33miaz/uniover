"""Pareamento Samsung: o token do WebSocket vai direto para o Cofre de Credenciais.

A biblioteca aceita `token=`; não há motivo para criar o `token_file` que ela também oferece.
"""

import asyncio
import logging

from uniover_agent.adapters.tv_samsung import SamsungClient, SamsungFactory, _default_factory

SAMSUNG_PAIR_TIMEOUT_SECONDS = 60.0
_log = logging.getLogger(__name__)


class SamsungPairingError(Exception):
    """Falha do pareamento Samsung, sem propagar detalhes que podem trazer o token."""


async def pair_samsung_tv(
    host: str,
    name: str,
    *,
    factory: SamsungFactory = _default_factory,
) -> str:
    """Espera o aceite na TV e devolve apenas o token para quem o guarda no cofre."""
    client: SamsungClient = factory(host, None, name)
    try:
        async with asyncio.timeout(SAMSUNG_PAIR_TIMEOUT_SECONDS):
            await asyncio.to_thread(client.open)
        if not client.token:
            raise SamsungPairingError("a TV não entregou o token de pareamento")
        return client.token
    except TimeoutError:
        raise SamsungPairingError("o aviso na TV não foi aceito em até 60 segundos") from None
    except SamsungPairingError:
        raise
    except Exception:
        raise SamsungPairingError(
            "não consegui parear com a TV Samsung; confira o endereço, se ela está ligada "
            "e aceite o aviso"
        ) from None
    finally:
        try:
            await asyncio.to_thread(client.close)
        except Exception:
            _log.warning("falha ao fechar o canal Samsung depois do pareamento")
