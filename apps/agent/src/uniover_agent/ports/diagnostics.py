"""Porta do diagnóstico do próprio agente: onde as ocorrências esperam para ir à API."""

from dataclasses import dataclass
from typing import Literal, Protocol

Severity = Literal["info", "warn", "error"]


@dataclass(frozen=True, slots=True)
class DiagnosticEvent:
    """Uma ocorrência do agente, já limpa de dados pessoais, no formato do contrato.

    `at` é UTC com sufixo `Z`; `count` diz quantas vezes a mesma ocorrência se repetiu antes de ser
    gravada (o agente resume repetições em vez de enchê-las uma a uma).
    """

    id: str
    at: str
    kind: str
    severity: Severity
    detail: str
    component: str | None = None
    count: int = 1


class DiagnosticStore(Protocol):
    """Fila local e limitada das ocorrências que ainda não foram à API.

    Outros processos do mesmo PC (o supervisor do Windows) também acrescentam a ela; por isso quem
    lê precisa tolerar linhas que não entende.
    """

    def append(self, event: DiagnosticEvent) -> None:
        """Acrescenta uma ocorrência. Nunca levanta: diagnóstico não pode derrubar quem o grava."""
        ...

    def take(self, limit: int) -> list[DiagnosticEvent]:
        """Tira da fila até `limit` ocorrências, as mais antigas primeiro."""
        ...

    def put_back(self, events: list[DiagnosticEvent]) -> None:
        """Devolve ao começo da fila o que não pôde ser enviado."""
        ...
