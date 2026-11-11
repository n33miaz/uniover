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


class DrillPcInput:
    """A entrada do PC do ensaio: aceita tudo e não faz nada. Nunca chama o Windows."""

    def move(self, _dx: int, _dy: int) -> None:
        pass

    def scroll(self, _horizontal: int, _vertical: int) -> None:
        pass

    def zoom(self, _steps: int) -> None:
        pass

    def click(self, _button: str, _action: str, _modifiers: object = ()) -> None:
        pass

    def key(self, _key: str, _modifiers: object, *, repeat: int = 1, action: str = "PRESS") -> None:
        pass

    def type_text(self, _text: str) -> None:
        pass

    def edit_text(self, _erase: int, _text: str, _key: str | None = None) -> None:
        pass

    def media(self, _action: str, _steps: int) -> None:
        pass

    def release_all(self) -> None:
        pass

    def release_orphans(self) -> None:
        pass


def _drill_send_input(_inputs: object) -> None:
    """O destino final de todo evento de entrada no ensaio: nenhum."""


def _install_pc_double() -> None:
    """O ensaio manda `pc.key.v1` durante a passagem: a tecla percorre o manipulador real do agente,
    mas a entrada é um dublê e o destino do `SendInput` também (as duas pontas, para nenhuma
    construção de `WindowsPcInput` por outro caminho chegar ao desktop de quem roda o ensaio)."""
    from uniover_agent.adapters import pc_windows  # noqa: PLC0415
    from uniover_agent.composition import pc as pc_composition  # noqa: PLC0415

    pc_windows._send_input = _drill_send_input  # type: ignore[assignment]
    pc_windows.WindowsPcInput = DrillPcInput  # type: ignore[assignment,misc]
    pc_composition.WindowsPcInput = DrillPcInput  # type: ignore[assignment,misc]


def _install_pc_guard() -> None:
    """Só age no ensaio (`UNIOVER_UPDATE_DRILL=1`, que o ambiente do ensaio sempre traz). Se o dublê
    não pôde ser instalado (versão sem o módulo, erro qualquer), falha FECHADO: o controle do PC é
    desligado neste processo e `pc.key.v1` é recusado, nunca enviado ao desktop."""
    if os.environ.get("UNIOVER_UPDATE_DRILL") != "1":
        return
    try:
        _install_pc_double()
    except Exception:
        os.environ["UNIOVER_PC_CONTROL"] = "false"


try:
    _install()
except Exception:  # noqa: S110 - um desvio que falha não pode derrubar o interpretador
    pass
_install_pc_guard()
