"""Apoio do ensaio de atualização: desvia as consultas do atualizador para o servidor local.

A versão BASE do ensaio (o que está publicado na `main`) ainda não conhece o modo ensaio de
`self_update.py`; este arquivo, carregado só pelo ambiente do ensaio via PYTHONPATH, faz as
duas URLs do GitHub irem para o servidor local do ensaio. Só age com `UNIOVER_UPDATE_DRILL=1` e
uma origem `http://127.0.0.1:porta`, mexe apenas nessas duas URLs e nunca levanta erro.
"""

import os

_COMMIT = "https://api.github.com/repos/n33miaz/uniover/commits/main"
_ARCHIVE = "https://github.com/n33miaz/uniover/archive/"


def _install() -> None:
    origin = os.environ.get("UNIOVER_UPDATE_SOURCE_URL", "").rstrip("/")
    if os.environ.get("UNIOVER_UPDATE_DRILL") != "1" or not origin.startswith("http://127.0.0.1:"):
        return
    import httpx  # noqa: PLC0415 - só é importado quando o ensaio está ligado

    def redirect(url: object) -> str:
        text = str(url)
        if text.startswith(_COMMIT):
            return f"{origin}/commit"
        if text.startswith(_ARCHIVE):
            return f"{origin}/archive/{text[len(_ARCHIVE) :]}"
        return text

    real_get, real_stream = httpx.get, httpx.stream

    def get(url: object, *args: object, **kwargs: object) -> object:
        return real_get(redirect(url), *args, **kwargs)  # type: ignore[arg-type]

    def stream(method: str, url: object, *args: object, **kwargs: object) -> object:
        return real_stream(method, redirect(url), *args, **kwargs)  # type: ignore[arg-type]

    httpx.get = get  # type: ignore[assignment]
    httpx.stream = stream  # type: ignore[assignment]


try:
    _install()
except Exception:  # noqa: S110 - um desvio que falha não pode derrubar o interpretador
    pass
