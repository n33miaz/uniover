"""Ícone opcional da bandeja do Windows, isolado do processo que controla a TV."""

import json
import os
import sys
import time
import webbrowser
from typing import Any

import pystray  # type: ignore[import-untyped]
from PIL import Image, ImageDraw

from uniover_agent.adapters.installation import installation_base
from uniover_agent.adapters.tray_status import status_path
from uniover_agent.config import Settings


def _icon(state: dict[str, Any]) -> Image.Image:
    """Mantém o símbolo do UniOver e uma bolinha de estado legível em 16 px."""
    asset = installation_base() / "app" / "assets" / "uniover.ico"
    try:
        image = Image.open(asset).convert("RGBA").resize((64, 64))
    except OSError, ValueError:
        image = Image.new("RGBA", (64, 64), (20, 45, 85, 255))
    draw = ImageDraw.Draw(image)
    if not asset.is_file():
        draw.rounded_rectangle((9, 12, 55, 48), radius=7, fill=(255, 255, 255, 255))
        draw.rectangle((18, 20, 46, 38), fill=(20, 45, 85, 255))
    color = (210, 65, 65, 255)
    if state.get("connected"):
        color = (50, 175, 95, 255) if state.get("power") == "on" else (235, 165, 45, 255)
    draw.ellipse((43, 43, 61, 61), fill=color, outline=(255, 255, 255, 255), width=2)
    return image


def _state() -> dict[str, Any]:
    try:
        decoded: object = json.loads(status_path().read_text(encoding="utf-8"))
        return decoded if isinstance(decoded, dict) else {}
    except OSError, ValueError:
        return {"connected": False, "power": "unknown", "tv_name": "TV"}


def _title(state: dict[str, Any]) -> str:
    tv = str(state.get("tv_name") or "TV")
    if not state.get("connected"):
        return f"UniOver - desconectado ({tv})"
    if state.get("power") == "on":
        return f"UniOver - {tv} ligada"
    if state.get("power") == "off":
        return f"UniOver - {tv} desligada"
    return f"UniOver - conectado ({tv})"


def run_tray() -> int:
    """Roda até o processo morrer; falta de bandeja é uma falha inofensiva para o wrapper."""
    settings = Settings()
    root = installation_base()

    def open_site(_: pystray.Icon, __: pystray.MenuItem) -> None:
        webbrowser.open(settings.api_url or "https://uniover.onrender.com")

    def open_log(_: pystray.Icon, __: pystray.MenuItem) -> None:
        path = root / "logs" / "agent.log"
        if path.exists() and sys.platform == "win32":
            os.startfile(path)  # noqa: S606

    def signal(name: str) -> None:
        (root / "runtime").mkdir(parents=True, exist_ok=True)
        (root / "runtime" / name).touch()

    icon = pystray.Icon(
        "UniOver",
        _icon(_state()),
        "UniOver",
        pystray.Menu(
            pystray.MenuItem("Abrir o UniOver", open_site),
            pystray.MenuItem("Ver registro", open_log),
            pystray.MenuItem("Atualizar agora", lambda *_: signal("update-now")),
            pystray.MenuItem("Reiniciar o agente", lambda *_: signal("restart-now")),
        ),
    )

    def refresh() -> None:
        previous = ""
        while True:
            state = _state()
            encoded = json.dumps(state, sort_keys=True)
            if encoded != previous:
                icon.icon = _icon(state)
                icon.title = _title(state)
                previous = encoded
            time.sleep(2)

    icon.run(setup=lambda _: __import__("threading").Thread(target=refresh, daemon=True).start())
    return 0
