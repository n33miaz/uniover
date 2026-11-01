"""Leitura do fim do registro do próprio agente (arquivo fixo, nunca um caminho vindo da rede)."""

from pathlib import Path
from typing import Final

from uniover_agent.ports.remote_care import LogUnavailable

# Mais que o rodízio de 1 MB do registro nunca é lido: o fim é o que serve à manutenção.
_READ_LIMIT_BYTES: Final = 512 * 1024


# Quantas linhas do registro do supervisor vão junto no fim: o que ele decidiu (atualizar,
# reiniciar, voltar atrás) explica muita queda, e fica em outro arquivo para não disputar o
# rodízio do agente.
SUPERVISOR_LINES: Final = 40
SUPERVISOR_HEADER: Final = "--- supervisor.log (supervisor e lançador do Windows) ---"


class FileLogSource:
    def __init__(
        self, path: Path, *, fallback: Path | None = None, supervisor: Path | None = None
    ) -> None:
        self._path = path
        self._fallback = fallback
        self._supervisor = supervisor

    def _file(self) -> Path:
        if self._path.is_file():
            return self._path
        if self._fallback is not None and self._fallback.is_file():
            return self._fallback
        raise LogUnavailable("este agente ainda não grava registro em arquivo")

    def tail(self, lines: int) -> list[str]:
        extra = self._supervisor_tail(min(SUPERVISOR_LINES, max(0, lines // 4)))
        found = self._tail(self._file(), lines - len(extra) - (1 if extra else 0))
        return [*found, SUPERVISOR_HEADER, *extra] if extra else found

    def _supervisor_tail(self, lines: int) -> list[str]:
        if self._supervisor is None or lines < 1 or not self._supervisor.is_file():
            return []
        try:
            return self._tail(self._supervisor, lines)
        except LogUnavailable:
            return []

    @staticmethod
    def _tail(path: Path, lines: int) -> list[str]:
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
