import type { components } from '../../core/api/generated/schema';

/** Uma ocorrência do agente, já normalizada (o contrato gerado manda `count` como número ou texto). */
export interface AgentDiagnostic {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly at: string;
  readonly kind: string;
  readonly severity: AgentDiagnosticSeverity;
  readonly component: string | null;
  readonly detail: string;
  readonly count: number;
}

export type AgentDiagnosticSeverity = 'info' | 'warn' | 'error';

/** A lista como a tela a usa: as ocorrências e por quantos dias a API as guarda. */
export interface AgentDiagnostics {
  readonly retentionDays: number;
  readonly items: readonly AgentDiagnostic[];
}

type Dto = components['schemas']['AgentDiagnosticsResponse'];

/** A API só entrega as três severidades; o que vier de fora do contrato vira aviso, nunca some nem finge ser erro. */
function severityOf(value: string): AgentDiagnosticSeverity {
  return value === 'info' || value === 'error' ? value : 'warn';
}

export function readAgentDiagnostics(dto: Dto): AgentDiagnostics {
  return {
    retentionDays: Number(dto.retentionDays) || 7,
    items: dto.items.map((item) => ({
      id: item.id,
      agentId: item.agentId,
      agentName: item.agentName,
      at: item.at,
      kind: item.kind,
      severity: severityOf(item.severity),
      component: item.component ?? null,
      detail: item.detail,
      count: Math.max(1, Number(item.count) || 1),
    })),
  };
}

/** Os `kind` que o agente manda, em palavras da pessoa. Um `kind` novo cai no texto neutro do `default`. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'background.failed':
      return $localize`:@@settings.system.agent-errors.kind.background-failed:Tarefa de fundo falhou`;
    case 'process.crashed':
      return $localize`:@@settings.system.agent-errors.kind.process-crashed:O agente caiu`;
    case 'process.unresponsive':
      return $localize`:@@settings.system.agent-errors.kind.process-unresponsive:O agente travou e foi reiniciado`;
    case 'repair.done':
      return $localize`:@@settings.system.agent-errors.kind.repair-done:Reparo feito`;
    case 'repair.failed':
      return $localize`:@@settings.system.agent-errors.kind.repair-failed:Reparo não funcionou`;
    case 'check.failed':
      return $localize`:@@settings.system.agent-errors.kind.check-failed:Verificação falhou`;
    case 'update.rejected':
      return $localize`:@@settings.system.agent-errors.kind.update-rejected:Atualização recusada`;
    case 'update.rolled_back':
      return $localize`:@@settings.system.agent-errors.kind.update-rolled-back:Voltou para a versão anterior`;
    case 'update.failed':
      return $localize`:@@settings.system.agent-errors.kind.update-failed:Atualização falhou`;
    case 'startup.task_missing':
      return $localize`:@@settings.system.agent-errors.kind.startup-task-missing:Início automático refeito`;
    case 'agent.started':
      return $localize`:@@settings.system.agent-errors.kind.agent-started:Agente iniciado`;
    case 'diagnostics.dropped':
      return $localize`:@@settings.system.agent-errors.kind.dropped:Eventos descartados`;
    default:
      return $localize`:@@settings.system.agent-errors.kind.other:Ocorrência (${kind}:kind:)`;
  }
}

export function severityLabel(severity: AgentDiagnosticSeverity): string {
  switch (severity) {
    case 'info':
      return $localize`:@@settings.system.agent-errors.severity.info:Info`;
    case 'warn':
      return $localize`:@@settings.system.agent-errors.severity.warn:Aviso`;
    case 'error':
      return $localize`:@@settings.system.agent-errors.severity.error:Erro`;
  }
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias". Futuro (relógio do PC adiantado) conta como agora. */
export function timeAgo(at: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return $localize`:@@settings.system.agent-errors.when.now:agora`;
  if (minutes < 60) {
    return $localize`:@@settings.system.agent-errors.when.minutes:há ${minutes}:count: min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return $localize`:@@settings.system.agent-errors.when.hours:há ${hours}:count: h`;
  const days = Math.floor(hours / 24);
  return days === 1
    ? $localize`:@@settings.system.agent-errors.when.day:há 1 dia`
    : $localize`:@@settings.system.agent-errors.when.days:há ${days}:count: dias`;
}

export function countLabel(count: number): string {
  return $localize`:@@settings.system.agent-errors.count:${count}:count: vezes`;
}
