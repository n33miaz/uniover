"""Página local, autocontida, para o QR do pareamento do PC."""

import ctypes
import html
import os
import sys
import webbrowser
from pathlib import Path

import segno


def pairing_page_html(link: str, user_code: str) -> str:
    """HTML sem rede para mostrar o QR e o código público do pareamento."""
    qr = segno.make(link, error="m")
    qr_data = qr.svg_data_uri(scale=12, border=4, dark="#111827", light="#ffffff")
    safe_link = html.escape(link, quote=True)
    safe_code = html.escape(user_code)
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar PC · UniOver</title>
<style>
body {{ margin: 0; background: #f8fafc; color: #111827; font: 20px/1.5 system-ui, sans-serif; }}
main {{ box-sizing: border-box; max-width: 720px; margin: 0 auto; padding: 32px 24px;
text-align: center; }}
h1 {{ margin: 0 0 24px; font-size: 32px; }}
img {{ display: block; width: min(100%, 520px); height: auto; margin: 0 auto 24px; }}
.code {{ margin: 0 0 24px; font-size: clamp(32px, 8vw, 56px); font-weight: 700;
letter-spacing: .08em; }}
p {{ margin: 0 0 24px; }}
a {{ color: #075985; font-weight: 700; }}
img {{ background: #ffffff; }}
@media (prefers-color-scheme: dark) {{
body {{ background: #0f172a; color: #f1f5f9; }}
a {{ color: #7dd3fc; }}
}}
</style>
</head>
<body>
<main>
<h1>Conectar este PC</h1>
<img src="{qr_data}" alt="QR para aprovar este PC no UniOver">
<p class="code">{safe_code}</p>
<p>Escaneie com o celular de quem administra o UniOver</p>
<p><a href="{safe_link}">Aprovar neste computador</a></p>
</main>
</body>
</html>
"""


def _message_page(title: str, message: str) -> str:
    """Página só com uma mensagem (sem QR nem código, que já não servem)."""
    safe_title = html.escape(title)
    safe_message = html.escape(message)
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_title} · UniOver</title>
<style>
body {{ margin: 0; background: #f8fafc; color: #111827; font: 24px/1.5 system-ui, sans-serif; }}
main {{ box-sizing: border-box; max-width: 720px; margin: 0 auto; padding: 64px 24px;
text-align: center; }}
h1 {{ margin: 0; font-size: 32px; }}
@media (prefers-color-scheme: dark) {{
body {{ background: #0f172a; color: #f1f5f9; }}
}}
</style>
</head>
<body><main><h1>{safe_message}</h1></main></body>
</html>
"""


def connected_page_html() -> str:
    """Página final de sucesso."""
    return _message_page("PC conectado", "PC conectado. Pode fechar esta janela.")


def failed_page_html() -> str:
    """Página para código vencido ou recusado: manda rodar o conector de novo."""
    return _message_page(
        "Conexão não concluída",
        "A conexão não foi concluída. Feche esta janela e rode o conector de novo.",
    )


def write_pairing_page(path: Path, link: str, user_code: str) -> None:
    """Grava a página antes de o agente começar a esperar a aprovação."""
    _write(path, pairing_page_html(link, user_code))


def write_connected_page(path: Path) -> None:
    """Substitui a página de QR depois que o pareamento termina."""
    _write(path, connected_page_html())


def write_failed_page(path: Path) -> None:
    """Substitui a página de QR quando o código venceu ou foi recusado."""
    _write(path, failed_page_html())


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def can_open_browser() -> bool:
    """Há uma sessão gráfica do usuário, não um teste, CI ou serviço do Windows?"""
    if os.environ.get("CI") or os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    if sys.platform == "win32":
        session_id = ctypes.c_uint()
        if not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session_id)):
            return False
        return session_id.value != 0
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def open_connection_page(path: Path) -> None:
    """Abre a página no navegador padrão, sem depender da rede."""
    if sys.platform == "win32":
        startfile = getattr(os, "startfile", None)
        if startfile is not None:
            startfile(str(path))
            return
    webbrowser.open(path.resolve().as_uri(), new=1)
