"""Quais apps da TV aparecem para o dono e com que nome.

O `adb` não dá o nome legível de um app, só o pacote. Então os nomes vêm de uma tabela de apps
conhecidos e, para o resto, de um nome derivado do pacote; o dono renomeia pela tela. Os apps que
são peças do sistema da TV (e não apps de uso) ficam de fora.

As listas abaixo são de propósito simples de ajustar: acrescentar um app conhecido ou esconder um
componente é uma linha.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final

from uniover_agent.ports import LaunchableApp

# Limite do contrato de `tv.apps.v1`.
MAX_APPS: Final = 500
MAX_LABEL_LENGTH: Final = 100


@dataclass(frozen=True, slots=True)
class AppEntry:
    """Um app para mostrar: pacote e nome (é o que `tv.apps.v1` leva)."""

    package: str
    label: str
    # Instalado pelo dono (não vem com a TV): aparece antes na lista.
    user_installed: bool = False


KNOWN_LABELS: Final[dict[str, str]] = {
    "com.google.android.youtube.tv": "YouTube",
    "com.google.android.youtube.tvkids": "YouTube Kids",
    "com.google.android.youtube.tvmusic": "YouTube Music",
    "com.netflix.ninja": "Netflix",
    "com.amazon.amazonvideo.livingroom": "Prime Video",
    "com.disney.disneyplus": "Disney+",
    "com.wbd.stream": "Max",
    "com.spotify.tv.android": "Spotify",
    "com.android.vending": "Play Store",
    "com.android.tv.settings": "Configurações",
    "com.google.android.videos": "Google Play Filmes",
    "com.globo.globotv": "Globoplay",
    "tv.twitch.android.app": "Twitch",
    "com.plexapp.android": "Plex",
    "org.xbmc.kodi": "Kodi",
    "com.cnvs.apptv": "CineVS",
    "org.videolan.vlc": "VLC",
    "com.crunchyroll.crunchyroid": "Crunchyroll",
    "com.apple.atve.androidtv.appletv": "Apple TV",
    "tv.pluto.android": "Pluto TV",
    "com.cbs.ott": "Paramount+",
    "deezer.android.tv": "Deezer",
}

# Pacotes que são peças do sistema da TV, não apps de uso. Prefixo (termina em ponto) ou nome exato.
# `com.tcl.` esconde os utilitários do fabricante; o que for útil de verdade entra em `SHOWN`.
HIDDEN_PREFIXES: Final = (
    "com.tcl.",
    "com.mediatek.",
    "com.droidlogic.",
    "com.android.managedprovisioning",
    "com.android.tv.feedback",
    "com.google.android.tvrecommendations",
    "com.google.android.tv.remote.service",
)
# Pedaços de nome que marcam configuração inicial, teste e engenharia, em qualquer fabricante.
HIDDEN_FRAGMENTS: Final = (
    "setupwraith",
    "setupwizard",
    "initsetup",
    "provision",
    "factory",
    "engineer",
)
# Exceções ao filtro acima (pacote exato). Vazio: nenhum utilitário `com.tcl.` é claramente útil.
SHOWN: Final[frozenset[str]] = frozenset()

# Partes de pacote que não dizem o nome do app (`com.spotify.tv.android` -> "Spotify").
_GENERIC_PARTS: Final = frozenset(
    {"android", "tv", "app", "apps", "mobile", "client", "ninja", "ott"}
)


def is_user_app(package: str) -> bool:
    """`False` para peças do sistema da TV que não fazem sentido como atalho."""
    if package in SHOWN:
        return True
    lowered = package.lower()
    if lowered.startswith(HIDDEN_PREFIXES):
        return False
    return not any(fragment in lowered for fragment in HIDDEN_FRAGMENTS)


def label_for(package: str) -> str:
    """Nome conhecido do app ou, se não houver, o derivado do pacote (sempre não vazio)."""
    known = KNOWN_LABELS.get(package)
    if known is not None:
        return known
    parts = [part for part in package.split(".") if part]
    # Da direita para a esquerda, a primeira parte que diz alguma coisa. A primeira parte do
    # pacote é o domínio de topo (`com`, `org`) e só entra se não sobrar nada melhor.
    saying = [part for part in reversed(parts[1:]) if part.lower() not in _GENERIC_PARTS]
    chosen = saying[0] if saying else (parts[1] if len(parts) > 1 else package)
    words = chosen.replace("_", " ").split()
    label = " ".join(word[:1].upper() + word[1:] for word in words) or package
    return label[:MAX_LABEL_LENGTH]


def describe_apps(launchables: Iterable[LaunchableApp]) -> list[AppEntry]:
    """Apps de uso com nome: os do dono antes dos da TV, cada grupo por nome.

    Sem repetir pacote e no limite do contrato.
    """
    entries: dict[str, AppEntry] = {}
    for app in launchables:
        if app.package in entries or not is_user_app(app.package):
            continue
        entries[app.package] = AppEntry(app.package, label_for(app.package), app.user_installed)
    # Os que o dono instalou primeiro; dentro de cada grupo, por nome.
    ordered = sorted(
        entries.values(),
        key=lambda entry: (not entry.user_installed, entry.label.casefold(), entry.package),
    )
    return ordered[:MAX_APPS]
