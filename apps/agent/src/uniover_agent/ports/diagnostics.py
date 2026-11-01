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
        """Empresta da fila até `limit` ocorrências, as mais antigas primeiro.

        O que foi emprestado continua guardado até `confirm`: se o processo cair ou o envio for
        cancelado no meio, nada se perde (a API ignora o `id` repetido, então reenviar é seguro)."""
        ...

    def confirm(self, events: list[DiagnosticEvent]) -> None:
        """O lote emprestado foi entregue (ou descartado de propósito): sai de vez da fila."""
        ...

    def put_back(self, events: list[DiagnosticEvent]) -> None:
        """O lote emprestado não pôde ser enviado: volta a ficar disponível, no começo da fila."""
        ...
