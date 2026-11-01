"""Confere a assinatura Android do APK do launcher contra o certificado fixado pelo dono.

O hash publicado ao lado do APK só protege de download corrompido: quem trocasse o arquivo da
publicação trocaria o hash junto. A autenticidade vem do certificado de assinatura do projeto,
fixado (SHA-256) na configuração do agente e conferido com o `apksigner` do Android SDK antes de
qualquer `adb install`. Sem certificado fixado, ou sem `apksigner` para conferir, **nada é
instalado**: é a escolha segura, e a mensagem diz o que falta.
"""

import logging
import re
import sys
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Final

from uniover_agent.adapters.apk_tools import locate_build_tool
from uniover_agent.adapters.tv_adb import run_process
from uniover_agent.adapters.tv_adb_parsing import AdbOutput
from uniover_agent.ports.tv_livre import LauncherApkError

_log = logging.getLogger(__name__)

_APKSIGNER: Final = "apksigner.bat" if sys.platform == "win32" else "apksigner"
_DIGEST: Final = re.compile(
    r"Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", re.IGNORECASE
)
DEFAULT_TIMEOUT_SECONDS: Final = 60.0

Runner = Callable[[Sequence[str], float], Awaitable[AdbOutput]]


def locate_apksigner(configured: str | None) -> Path | None:
    return locate_build_tool(_APKSIGNER, configured)


class ApkSignerVerifier:
    def __init__(
        self,
        pinned: frozenset[str],
        apksigner: Path | None,
        *,
        runner: Runner | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._pinned = pinned
        self._apksigner = apksigner
        self._run: Runner = runner or run_process
        self._timeout = timeout

    async def __call__(self, apk: Path) -> None:
        if not self._pinned:
            raise LauncherApkError(
                "signer_not_pinned",
                "Falta fixar o certificado do TV Livre (UNIOVER_TV_LIVRE_SIGNER_SHA256); "
                "nada foi instalado.",
            )
        if self._apksigner is None:
            raise LauncherApkError(
                "signer_unverifiable",
                "Não achei o apksigner do Android SDK para conferir a assinatura; nada instalado.",
            )
        try:
            output = await self._run(
                [str(self._apksigner), "verify", "--print-certs", str(apk)], self._timeout
            )
        except (TimeoutError, OSError) as exc:
            _log.warning("não consegui executar o apksigner (%s)", type(exc).__name__)
            raise LauncherApkError(
                "signer_unverifiable", "Não consegui executar o apksigner; nada foi instalado."
            ) from None
        digests = {match.lower() for match in _DIGEST.findall(output.text)}
        if output.returncode != 0 or not digests:
            raise LauncherApkError(
                "apk_signature_invalid", "A assinatura do launcher baixado não é válida."
            )
        if not digests <= self._pinned:
            raise LauncherApkError(
                "apk_signer_mismatch",
                "O launcher baixado não foi assinado pelo certificado esperado.",
            )
