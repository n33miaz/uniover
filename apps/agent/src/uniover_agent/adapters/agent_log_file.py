"""Leitura do fim do registro do próprio agente (arquivo fixo, nunca um caminho vindo da rede)."""

from pathlib import Path
from typing import Final

from uniover_agent.ports.remote_care import LogUnavailable

# Mais que o rodízio de 1 MB do registro nunca é lido: o fim é o que serve à manutenção.
_READ_LIMIT_BYTES: Final = 512 * 1024


class FileLogSource:
    def __init__(self, path: Path, *, fallback: Path | None = None) -> None:
        self._path = path
        self._fallback = fallback

    def _file(self) -> Path:
        if self._path.is_file():
            return self._path
        if self._fallback is not None and self._fallback.is_file():
            return self._fallback
        raise LogUnavailable("este agente ainda não grava registro em arquivo")

    def tail(self, lines: int) -> list[str]:
        path = self._file()
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                size = handle.tell()
                start = max(0, size - _READ_LIMIT_BYTES)
                handle.seek(start)
                data = handle.read()
        except OSError:
            raise LogUnavailable("não consegui ler o arquivo de registro") from None
        text = data.decode("utf-8", errors="replace")
        found = text.splitlines()
        if start > 0 and found:
            # Começou no meio de uma linha: a primeira não é inteira.
            found = found[1:]
        return found[-lines:]
