import type { components } from '../../core/api/generated/schema';

type Schemas = components['schemas'];

/** Uma linha da trilha como a API a entrega (tipo gerado do OpenAPI). */
export type AuditItem = Readonly<Schemas['AuditItem']>;
export type AuditPage = Readonly<Schemas['AuditPage']>;
export type AuditSources = Readonly<Schemas['AuditSourcesResponse']>;
export type AuditSource = Readonly<Schemas['AuditSourceSummary']>;

/** Os resultados que a API usa em `outcome`. */
export type AuditOutcome = 'success' | 'failure' | 'denied';

/** As janelas de tempo que o filtro oferece; `any` não limita o período. */
export type AuditPeriod = 'any' | '24h' | '7d' | '30d';

export const AUDIT_PERIODS: readonly AuditPeriod[] = ['any', '24h', '7d', '30d'];

/** Uma pessoa que dá para escolher no filtro: o id da conta (é o que a API pede) e o nome atual. */
export interface AuditPerson {
  readonly id: string;
  readonly name: string;
}

/** O que a pessoa escolheu na folha de filtros. Tudo vazio = sem filtro. */
export interface AuditFilter {
  readonly person: AuditPerson | null;
  readonly modules: readonly string[];
  readonly action: string | null;
  readonly outcome: AuditOutcome | null;
  readonly period: AuditPeriod;
}

export const EMPTY_FILTER: AuditFilter = {
  person: null,
  modules: [],
  action: null,
  outcome: null,
  period: 'any',
};

/** O pedido à API: o filtro já com o período convertido em instantes. Fica congelado entre as páginas e a exportação. */
export interface AuditQuery {
  readonly person: string | null;
  readonly modules: readonly string[];
  readonly actions: readonly string[];
  readonly outcome: AuditOutcome | null;
  /** Instante inicial (ISO 8601, UTC); `null` = sem início. O fim nunca é usado: "até agora" é o padrão da API. */
  readonly from: string | null;
}

export const EMPTY_QUERY: AuditQuery = {
  person: null,
  modules: [],
  actions: [],
  outcome: null,
  from: null,
};

const HOUR_MS = 60 * 60 * 1000;
const PERIOD_MS: Readonly<Record<Exclude<AuditPeriod, 'any'>, number>> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/**
 * O pedido que corresponde ao filtro. O período é relativo a `now` e vira um instante fixo: a "página 2" e o arquivo
 * exportado usam o mesmo início da "página 1", em vez de cada um olhar o relógio de novo e enxergar uma janela diferente.
 */
export function resolveQuery(filter: AuditFilter, now: Date): AuditQuery {
  return {
    person: filter.person?.id ?? null,
    modules: filter.modules,
    actions: filter.action ? [filter.action] : [],
    outcome: filter.outcome,
    from:
      filter.period === 'any'
        ? null
        : new Date(now.getTime() - PERIOD_MS[filter.period]).toISOString(),
  };
}

/** Quantos filtros estão ligados (a pessoa, os módulos juntos, a ação, o resultado e o período). */
export function activeFilterCount(filter: AuditFilter): number {
  return (
    Number(filter.person !== null) +
    Number(filter.modules.length > 0) +
    Number(filter.action !== null) +
    Number(filter.outcome !== null) +
    Number(filter.period !== 'any')
  );
}

export function sameFilter(a: AuditFilter, b: AuditFilter): boolean {
  return (
    a.person?.id === b.person?.id &&
    a.action === b.action &&
    a.outcome === b.outcome &&
    a.period === b.period &&
    a.modules.length === b.modules.length &&
    a.modules.every((module) => b.modules.includes(module))
  );
}

/** A chave de uma linha na lista: o id é único dentro de cada fonte, então a fonte entra junto. */
export function itemKey(item: AuditItem): string {
  return `${item.module}/${item.id}`;
}

export function isOutcome(value: string | null): value is AuditOutcome {
  return value === 'success' || value === 'failure' || value === 'denied';
}
