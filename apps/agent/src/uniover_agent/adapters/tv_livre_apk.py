"""Origem do APK do launcher do TV Livre: o artefato da publicação, conferido por hash.

A publicação deve trazer dois arquivos lado a lado: `uniover-launcher.apk` e
`uniover-launcher.apk.sha256` (o hash em hexadecimal, opcionalmente seguido do nome do arquivo).
O agente só entrega o APK ao ADB depois de o hash bater E de o `verifier` (a assinatura
conferida contra o certificado fixado, em `tv_livre_signer.py`) aceitar. O hash vem do mesmo
endereço (HTTPS) do APK: protege de download corrompido, mas quem trocasse a publicação trocaria
o hash junto; quem autentica é a assinatura.
"""

import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Final

import httpx

from uniover_agent.ports.tv_livre import LauncherApk, LauncherApkError

_log = logging.getLogger(__name__)

DEFAULT_BASE_URL: Final = "https://github.com/n33miaz/uniover/releases/latest/download"
APK_NAME: Final = "uniover-launcher.apk"
# O APK de release tem dezenas de KB; o teto só existe para não encher o disco com lixo.
MAX_APK_BYTES: Final = 5 * 1024 * 1024
_HASH: Final = re.compile(r"[0-9a-fA-F]{64}")
_ZIP_MAGIC: Final = b"PK\x03\x04"


class ReleaseApkSource:
    def __init__(
        self,
        base_url: str,
        scratch: Path,
        *,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        verifier: Callable[[Path], Awaitable[None]] | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("o endereço do APK do launcher precisa ser HTTPS")
        self._base = base_url.rstrip("/")
        self._scratch = scratch
        self._timeout = timeout
        self._verifier = verifier
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(follow_redirects=True, timeout=timeout)
        )

    async def fetch(self) -> LauncherApk:
        self._scratch.mkdir(parents=True, exist_ok=True)
        target = self._scratch / APK_NAME
        try:
            async with self._client_factory() as client:
                declared = await self._declared_hash(client)
                digest = hashlib.sha256()
                total = 0
                async with client.stream("GET", f"{self._base}/{APK_NAME}") as response:
                    response.raise_for_status()
                    with target.open("wb") as handle:
                        async for chunk in response.aiter_bytes():
                            total += len(chunk)
                            if total > MAX_APK_BYTES:
                                raise LauncherApkError(
                                    "apk_invalid", "O APK do launcher é grande demais."
                                )
                            digest.update(chunk)
                            handle.write(chunk)
        except httpx.HTTPError as exc:
            _log.info("TV Livre: não baixei o APK (%s)", type(exc).__name__)
            raise LauncherApkError(
                "apk_unavailable", "Não consegui baixar o launcher da publicação."
            ) from None
        if digest.hexdigest() != declared:
            target.unlink(missing_ok=True)
            raise LauncherApkError(
                "apk_hash_mismatch", "O launcher baixado não confere com o hash publicado."
            )
        if total == 0 or not target.read_bytes()[:4] == _ZIP_MAGIC:
            target.unlink(missing_ok=True)
            raise LauncherApkError("apk_invalid", "O arquivo baixado não é um APK.")
        if self._verifier is not None:
            try:
                await self._verifier(target)
            except LauncherApkError:
                target.unlink(missing_ok=True)
                raise
        return LauncherApk(target, declared)

    async def _declared_hash(self, client: httpx.AsyncClient) -> str:
        response = await client.get(f"{self._base}/{APK_NAME}.sha256")
        response.raise_for_status()
        token = response.text.strip().split()[0] if response.text.strip() else ""
        if not _HASH.fullmatch(token):
            raise LauncherApkError("apk_unavailable", "O hash publicado do launcher é ilegível.")
        return token.lower()
