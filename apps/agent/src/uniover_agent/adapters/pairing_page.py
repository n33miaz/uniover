"""Páginas locais da conexão do PC: andamento da instalação, QR do pareamento e desfecho.

Autocontidas (sem rede, sem script) e com o visual do app: mesmas cores do PWA, claro e escuro,
legíveis no celular. O instalador (`tools/install-windows.ps1`) escreve as mesmas páginas antes de
o agente existir no PC; o estilo é o mesmo texto nos dois lados (um teste confere) para a janela
não mudar de cara no meio da conexão.
"""

import ctypes
import html
import os
import sys
import webbrowser
from collections.abc import Sequence
from pathlib import Path
from typing import Final, Literal

import segno

# Intervalo, em segundos, com que a página de espera se recarrega para mostrar o desfecho.
REFRESH_SECONDS = 3

StepState = Literal["done", "now", "todo", "fail"]
Tone = Literal["info", "ok", "bad"]

# As etapas que a pessoa vê, na ordem; as mesmas chaves e nomes do instalador.
STEPS: Final = (
    ("prepare", "Preparar este computador"),
    ("phone", "Ligar ao seu celular"),
    ("tv", "Encontrar a TV"),
    ("ready", "Deixar tudo pronto"),
)

_STATE_TEXT: Final = {
    "done": "concluída",
    "now": "agora",
    "todo": "a seguir",
    "fail": "não deu certo",
}

# O símbolo do app, o mesmo da tela de entrar e do favicon (sem mudar nada nele), embutido na
# página para não depender de arquivo nem de rede. Só ASCII e sem aspas simples: o instalador o
# repete igual.
LOGO_SVG: Final = (
    '<svg class="logo" viewBox="0 0 512 512" aria-hidden="true" focusable="false">'
    '<rect width="512" height="512" rx="112" fill="#3B6B4B"/>'
    '<g fill="none" stroke="#FFFFFF" stroke-width="48" stroke-linecap="round">'
    '<circle cx="256" cy="256" r="70" fill="#FFFFFF" stroke="none"/>'
    '<path d="M362.1 149.9A150 150 0 0 1 362.1 362.1"/>'
    '<path d="M149.9 149.9A150 150 0 0 0 149.9 362.1"/>'
    "</g></svg>"
)

# Estilo único das páginas (só ASCII: o instalador o repete igual, num arquivo só ASCII).
PAGE_STYLE: Final = (
    ":root{color-scheme:light dark;--bg:#f2f5f1;--surface:#ffffff;--ink:#17201a;--ink2:#46544a;"
    "--line:#d0dad0;--accent:#3b6b4b;--accent-soft:#dcebdf;--on-accent:#ffffff;--ok:#0e7a5c;"
    "--bad:#b3261e;--bad-soft:#f8e3e1}"
    "@media (prefers-color-scheme: dark){:root{--bg:#101512;--surface:#181f1a;--ink:#e9efea;"
    "--ink2:#b0bdb3;--line:#2f3b33;--accent:#98c4a3;--accent-soft:#243a2b;--on-accent:#0a160d;"
    "--ok:#3fc7a3;--bad:#f0736b;--bad-soft:#3a1f1d}}"
    "*{box-sizing:border-box}"
    "body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;"
    "padding:24px 16px;background:var(--bg);color:var(--ink);"
    "font:17px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}"
    ".card{width:100%;max-width:560px;margin-top:4vh;padding:28px 24px;"
    "border:1px solid var(--line);border-radius:20px;background:var(--surface);"
    "box-shadow:0 6px 16px -4px rgb(23 32 26 / .12)}"
    ".brand{display:flex;align-items:center;gap:10px;margin:0 0 20px;font-weight:700;"
    "color:var(--accent)}"
    ".logo{flex:none;width:28px;height:28px;border-radius:22%}"
    "h1{margin:0 0 8px;font-size:1.6rem;line-height:1.25}"
    ".lead{margin:0 0 20px;color:var(--ink2);font-size:1.05rem}"
    ".lead.ok{color:var(--ok);font-weight:600}"
    ".lead.bad{padding:12px 14px;border-radius:12px;background:var(--bad-soft);color:var(--ink)}"
    ".qr{margin:0 0 20px;text-align:center}"
    ".qr img{display:block;width:min(100%,300px);height:auto;margin:0 auto 12px;padding:12px;"
    "border:1px solid var(--line);border-radius:16px;background:#ffffff}"
    ".code{margin:0 0 4px;font-size:clamp(1.8rem,7vw,2.6rem);font-weight:700;"
    "letter-spacing:.08em;font-variant-numeric:tabular-nums}"
    ".hint{margin:0 0 16px;color:var(--ink2);font-size:.95rem}"
    ".approve{display:inline-block;max-width:100%;min-height:44px;margin:0 0 4px;"
    "padding:12px 24px;border:2px solid var(--accent);border-radius:999px;color:var(--accent);"
    "font-weight:700;text-decoration:none}"
    ".approve:hover{background:var(--accent-soft)}"
    "a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}"
    ".steps{margin:0 0 16px;padding:0;list-style:none;border-top:1px solid var(--line)}"
    ".steps li{display:flex;align-items:center;gap:12px;padding:12px 0;"
    "border-bottom:1px solid var(--line);color:var(--ink2)}"
    ".mark{flex:none;display:grid;place-items:center;width:24px;height:24px;"
    "border:2px solid var(--line);border-radius:50%}"
    ".steps .done{color:var(--ink)}"
    ".steps .done .mark{border-color:var(--ok);background:var(--ok)}"
    '.steps .done .mark::after{content:"";width:6px;height:11px;border:solid var(--surface);'
    "border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg)}"
    ".steps .now{color:var(--ink);font-weight:600}"
    ".steps .now .mark{border-color:var(--accent);border-top-color:transparent;"
    "animation:spin 1s linear infinite}"
    ".steps .fail{color:var(--ink)}"
    ".steps .fail .mark{border-color:var(--bad);background:var(--bad)}"
    "@keyframes spin{to{transform:rotate(360deg)}}"
    "@media (prefers-reduced-motion: reduce){.steps .now .mark{animation:none;"
    "border-top-color:var(--accent);background:var(--accent-soft)}}"
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);"
    "white-space:nowrap}"
    ".foot{margin:0;color:var(--ink2);font-size:.9rem}"
)

_STILL_HERE = "Pode deixar esta janela aberta: ela se atualiza sozinha."
_CLOSE_NOW = "Pode fechar esta janela."


def step_states(current: str | None, *, failed: bool = False) -> list[tuple[str, StepState]]:
    """Estado de cada etapa: as anteriores à atual concluídas, a atual em andamento (ou com falha).

    `current` vazio (`None`) é o fim: todas concluídas.
    """
    keys = [key for key, _ in STEPS]
    if current is None:
        return [(key, "done") for key in keys]
    position = keys.index(current)
    states: list[tuple[str, StepState]] = []
    for index, key in enumerate(keys):
        if index < position:
            states.append((key, "done"))
        elif index == position:
            states.append((key, "fail" if failed else "now"))
        else:
            states.append((key, "todo"))
    return states


def _steps_html(states: Sequence[tuple[str, StepState]]) -> str:
    labels = dict(STEPS)
    items = "".join(
        f'<li class="{state}"><span class="mark" aria-hidden="true"></span>'
        f"<span>{html.escape(labels[key])}</span>"
        f'<span class="sr"> ({_STATE_TEXT[state]})</span></li>'
        for key, state in states
    )
    return f'<ol class="steps" aria-label="Etapas">{items}</ol>'


def page_html(  # noqa: PLR0913 - cada parte da página é opcional e nomeada
    title: str,
    message: str,
    *,
    tone: Tone = "info",
    steps: Sequence[tuple[str, StepState]] | None = None,
    body: str = "",
    refresh: bool = False,
    foot: str | None = None,
) -> str:
    """A página inteira. `body` já vem em HTML seguro (o bloco do QR); o resto é escapado aqui."""
    reload_tag = f'<meta http-equiv="refresh" content="{REFRESH_SECONDS}">' if refresh else ""
    foot_text = foot if foot is not None else (_STILL_HERE if refresh else _CLOSE_NOW)
    steps_html = _steps_html(steps) if steps else ""
    lead_class = "lead" if tone == "info" else f"lead {tone}"
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
{reload_tag}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · UniOver</title>
<style>{PAGE_STYLE}</style>
</head>
<body>
<main class="card" aria-labelledby="title">
<p class="brand">{LOGO_SVG}UniOver</p>
<h1 id="title">{html.escape(title)}</h1>
<p class="{lead_class}" role="status">{html.escape(message)}</p>
{body}
{steps_html}
<p class="foot">{html.escape(foot_text)}</p>
</main>
</body>
</html>
"""


def pairing_page_html(link: str, user_code: str, *, installing: bool = False) -> str:
    """O QR e o código público do pareamento, para o celular de quem já entrou no UniOver."""
    qr = segno.make(link, error="m")
    qr_data = qr.svg_data_uri(scale=10, border=4, dark="#17201a", light="#ffffff")
    safe_link = html.escape(link, quote=True)
    safe_code = html.escape(user_code)
    # A página de espera se recarrega sozinha: quando o agente a troca pela de sucesso (ou de
    # falha), o navegador mostra o resultado sem a pessoa fazer nada. O QR é o caminho principal;
    # o link serve a quem já entrou no UniOver neste mesmo computador.
    body = (
        '<div class="qr">'
        f'<img src="{qr_data}" alt="QR para aprovar este PC no UniOver pelo celular">'
        f'<p class="code">{safe_code}</p>'
        '<p class="hint">Sem câmera? No app, abra Ajustes, Dispositivos e digite este código.</p>'
        f'<a class="approve" href="{safe_link}" target="_blank" rel="noopener">'
        "Aprovar neste computador</a>"
        "</div>"
    )
    return page_html(
        "Ligue este PC ao seu celular",
        "Aponte a câmera do celular em que você já entrou no UniOver e toque em Aprovar. "
        "O resto termina sozinho.",
        steps=step_states("phone") if installing else None,
        body=body,
        refresh=True,
    )


def connected_page_html() -> str:
    """Página final de sucesso (pareamento feito fora do instalador)."""
    return page_html("PC conectado", "Este PC já está ligado ao UniOver.", tone="ok")


def progress_page_html(message: str, step: str = "phone") -> str:
    """Página de andamento da instalação: se recarrega sozinha até alguém a trocar pela seguinte."""
    return page_html("Conectando este PC", message, steps=step_states(step), refresh=True)


def failed_page_html() -> str:
    """Página para código vencido ou recusado: manda abrir o conector de novo."""
    return page_html(
        "Conexão não concluída",
        "O código venceu ou foi recusado. Abra o conector de novo para ganhar um código novo.",
        tone="bad",
    )


def write_pairing_page(path: Path, link: str, user_code: str, *, installing: bool = False) -> None:
    """Grava a página antes de o agente começar a esperar a aprovação."""
    _write(path, pairing_page_html(link, user_code, installing=installing))


def write_connected_page(path: Path) -> None:
    """Substitui a página de QR depois que o pareamento termina."""
    _write(path, connected_page_html())


def write_progress_page(path: Path, message: str, step: str = "phone") -> None:
    """Mostra o andamento da instalação na mesma página que o navegador já tem aberta."""
    _write(path, progress_page_html(message, step))


def write_failed_page(path: Path) -> None:
    """Substitui a página de QR quando o código venceu ou foi recusado."""
    _write(path, failed_page_html())


def _write(path: Path, content: str) -> None:
    """Grava por troca atômica: a página recarrega a cada poucos segundos e não lê meio arquivo."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        # No Windows o navegador pode estar com o arquivo aberto naquele instante: grava direto.
        temporary.unlink(missing_ok=True)
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
