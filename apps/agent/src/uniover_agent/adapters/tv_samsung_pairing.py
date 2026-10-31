"""Pareamento Samsung: o token do WebSocket vai direto para o Cofre de Credenciais.

A biblioteca aceita `token=`; não há motivo para criar o `token_file` que ela também oferece.
"""

import asyncio
import logging

from uniover_agent.adapters.tv_samsung import (
    SAMSUNG_PERMISSION_TIMEOUT_SECONDS,
    SAMSUNG_PORT,
    SamsungClient,
    SamsungFactory,
    _SamsungTvWs,
    is_permission_failure,
)

SAMSUNG_PAIR_TIMEOUT_SECONDS = SAMSUNG_PERMISSION_TIMEOUT_SECONDS
# `close()` é síncrono na biblioteca e algumas TVs não respondem ao fechamento. O pareamento já
# terminou neste ponto; não faz sentido segurar o instalador por isso.
SAMSUNG_CLOSE_TIMEOUT_SECONDS = 3.0
_log = logging.getLogger(__name__)


class SamsungPairingError(Exception):
    """Falha do pareamento Samsung, sem propagar detalhes que podem trazer o token."""


def _pairing_factory(host: str, token: str | None, name: str) -> SamsungClient:
    # A TV só responde ao WebSocket depois que alguém aceita o aviso: o tempo do socket precisa
    # cobrir a espera inteira, não os 5 s do controle (que estouravam antes do aceite).
    return _SamsungTvWs(
        host, token=token, port=SAMSUNG_PORT, timeout=SAMSUNG_PAIR_TIMEOUT_SECONDS, name=name
    )


async def pair_samsung_tv(
    host: str,
    name: str,
    *,
    token: str | None = None,
    factory: SamsungFactory = _pairing_factory,
) -> str:
    """Espera o aceite na TV e devolve apenas o token para quem o guarda no cofre.

    Com `token` (o que já estava guardado), uma TV que ainda o reconhece conecta sem mostrar
    aviso nenhum; uma que o esqueceu mostra o aviso "Permitir" e espera. O `name` é sempre o mesmo
    do primeiro pareamento: é a ele que a TV liga a permissão.
    """
    client: SamsungClient = factory(host, token, name)
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
    except Exception as exc:
        if is_permission_failure(exc):
            # Tempo esgotado do aviso, recusa ou a TV desistindo: nenhum token chegou.
            raise SamsungPairingError("o aviso na TV não foi aceito em até 60 segundos") from None
        raise SamsungPairingError(
            "não consegui parear com a TV Samsung; confira o endereço, se ela está ligada "
            "e aceite o aviso"
        ) from None
    finally:
        try:
            await asyncio.wait_for(
                asyncio.to_thread(client.close), timeout=SAMSUNG_CLOSE_TIMEOUT_SECONDS
            )
        except Exception:
            _log.warning("falha ao fechar o canal Samsung depois do pareamento")
