"""Porta do módulo TV Livre: o que o núcleo precisa do ADB e da origem do APK do launcher.

O núcleo monta cada comando do shell da TV como texto **fixo** (o único dado variável, o nome de
pacote, é validado antes) e só pergunta se deu certo. Assim o dublê dos testes pode simular o
gerenciador de pacotes do Android e registrar a ordem exata dos comandos, que é o que importa para
nunca deixar a TV sem tela inicial.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from uniover_agent.ports.tv_adb import LaunchableApp


@dataclass(frozen=True, slots=True)
class ShellResult:
    """Resposta de um comando do shell da TV: código de saída zero e o texto (as duas saídas)."""

    ok: bool
    text: str


class TvLivreAdb(Protocol):
    async def shell(self, command: str) -> ShellResult:
        """Um comando do shell da TV, no mesmo canal (e na mesma trava) dos demais. `AdbError`."""
        ...

    async def push(self, local: Path, remote: str) -> None:
        """Copia um arquivo do PC para a TV. Levanta `AdbError`."""
        ...

    async def install(self, apk: Path) -> ShellResult:
        """`adb install -r` do APK. A saída traz o motivo (`INSTALL_FAILED_...`) quando falha."""
        ...

    async def list_apps(self) -> list[LaunchableApp]:
        """Os apps que a TV mostra para abrir (a mesma fonte da lista de apps da tela)."""
        ...


class LauncherApkError(Exception):
    """O APK do launcher não está disponível ou não passou na conferência.

    `code` é estável (vai à API); `message` é seguro para a tela do dono.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class LauncherApk:
    """Um APK já baixado e conferido (tamanho e sha256 batem com o publicado)."""

    path: Path
    sha256: str


class LauncherApkSource(Protocol):
    async def fetch(self) -> LauncherApk:
        """Baixa o APK do launcher e confere o hash contra o que a publicação declarou.

        Levanta `LauncherApkError` (`apk_unavailable`, `apk_hash_mismatch`, `apk_invalid`).
        """
        ...
