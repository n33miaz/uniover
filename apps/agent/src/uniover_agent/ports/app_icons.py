"""Portas da extração dos ícones dos apps da TV.

O ícone de um app não é pedido à TV: ele está dentro do APK do app. O caminho é: descobrir o APK
(pelo ADB), trazê-lo para uma pasta temporária, perguntar ao `aapt2` qual arquivo é o ícone, ler só
esse arquivo de dentro do APK e guardar o resultado em cache por versão do app.

As mensagens dos erros são fixas e seguras para o registro: nunca trazem caminho do computador nem
conteúdo de imagem.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class IconToolError(Exception):
    """O `aapt2` ou a leitura do APK falhou (arquivo corrompido, ferramenta quebrada)."""


@dataclass(frozen=True, slots=True)
class AppIcon:
    """Imagem pronta para a API: `mime` (`image/png` ou `image/webp`) e os bytes."""

    mime: str
    data: bytes


@dataclass(frozen=True, slots=True)
class CachedIcon:
    """O que o cache guarda para uma versão de app: um ícone ou "esta versão não tem ícone útil".

    O segundo caso importa: sem ele um app cujo APK não oferece PNG nem WebP seria baixado de novo
    (dezenas de MB) a cada atualização da lista.
    """

    icon: AppIcon | None


class ApkSource(Protocol):
    """O lado da TV: versões instaladas, onde está o APK de um pacote e como trazê-lo."""

    async def package_versions(self) -> dict[str, int]:
        """`versionCode` de cada pacote instalado, numa só consulta. Levanta `AdbError`."""
        ...

    async def apk_paths(self, package: str) -> list[str]:
        """Caminhos dos APKs do pacote na TV, o principal (`base.apk`) primeiro. Pode ser vazio.

        Levanta `ValueError` se o pacote não tem o formato do Android e `AdbError` se a TV falhar.
        """
        ...

    async def pull_apk(self, remote_path: str, local_path: Path) -> None:
        """Copia um APK da TV. Não disputa a vez com os comandos interativos. Levanta `AdbError`."""
        ...


class ApkInspector(Protocol):
    """Lê um APK já copiado: pergunta ao `aapt2` e abre só o arquivo de imagem que interessa."""

    async def dump_badging(self, apk: Path) -> str:
        """Saída de `aapt2 dump badging`. Levanta `IconToolError`."""
        ...

    async def read_member(self, apk: Path, name: str, max_bytes: int) -> bytes | None:
        """Bytes do arquivo `name` do APK, ou `None` se não existe ou passa de `max_bytes`.

        Nunca extrai o APK: lê só esse arquivo. Levanta `IconToolError` se o APK está corrompido.
        """
        ...


class IconCache(Protocol):
    """Cache em disco por `pacote` e `versionCode`."""

    def load(self, package: str, version: int) -> CachedIcon | None:
        """`None` quando não há entrada para essa versão (nunca baixada)."""
        ...

    def store(self, package: str, version: int, icon: AppIcon | None) -> None:
        """Guarda (ou, com `None`, marca "sem ícone") e apaga as versões antigas do pacote."""
        ...


class ApkScratch(Protocol):
    """Pasta temporária do usuário onde o APK fica só o tempo de ler o ícone."""

    def new_path(self) -> Path:
        """Um caminho novo e único para um APK (o arquivo ainda não existe)."""
        ...

    def discard(self, path: Path) -> None:
        """Apaga o arquivo se existir. Nunca levanta."""
        ...
