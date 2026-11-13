import { Component, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import {
  AgentParity,
  DeadLetterEntry,
  DeadLetterReport,
  HealthAgent,
  ParityReport,
  SystemApi,
  TvItem,
} from './system-api';

/** Um módulo e a versão dele, como a lista de Módulos mostra. */
export interface ModuleRow {
  readonly key: string;
  readonly label: string;
  readonly version: string;
}

/** Os quatro números da paridade de um computador, já em texto, e se cada um cumpre a meta. */
export interface ParityRow {
  readonly slug: string;
  readonly name: string;
  readonly direct: string;
  readonly directTone: 'ok' | 'bad' | '';
  readonly reply: string;
  readonly lag: string;
  readonly lagTone: 'ok' | 'bad' | '';
  readonly unanswered: string;
  readonly unansweredTone: 'ok' | 'bad' | '';
}

/** As metas da revisão estratégica de 11/11 (D8): direto em 90% do uso, atraso do laço até 100 ms, nenhum comando sem resposta. */
export const PARITY_DIRECT_GOAL = 90;
export const PARITY_LAG_GOAL_MS = 100;

/**
 * Leitura resumida do que já existe: a presença mais recente do agente, a TV vinculada e o commit da API. Não cria
 * telemetria nem tenta consultar a TV diretamente.
 */
@Component({
  selector: 'app-system-health-section',
  imports: [LoadingSkeleton],
  templateUrl: './system-health-section.html',
  styleUrl: './system-health-section.css',
})
export class SystemHealthSection {
  private readonly system = inject(SystemApi);
  private readonly session = inject(SessionState);
  protected readonly agents = signal<readonly HealthAgent[] | null>(null);
  protected readonly tvs = signal<readonly TvItem[] | null>(null);
  protected readonly commit = signal<string | null>(null);
  protected readonly modules = signal<readonly ModuleRow[]>([]);
  protected readonly failed = signal(false);
  /** Os eventos internos que esgotaram as tentativas. `null` até chegar; fica `null` se a leitura falhar (o resto da Saúde segue). */
  protected readonly deadLetters = signal<DeadLetterReport | null>(null);
  protected readonly deadLettersFailed = signal(false);
  /** Os números da paridade; `null` até chegar ou se a leitura falhar (a tela mostra "—"). */
  protected readonly parity = signal<ParityReport | null>(null);
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  constructor() {
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.agents()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.failed.set(false);
    // Em paralelo e à parte: uma falha aqui não derruba o cartão inteiro da Saúde (a leitura nunca rejeita).
    void this.loadDeadLetters();
    void this.loadParity();
    try {
      const [agents, tvs, version] = await Promise.all([
        this.system.agents(),
        this.system.tvs(),
        this.system.deploymentVersion(),
      ]);
      this.agents.set(agents);
      this.tvs.set(tvs);
      this.commit.set(version.commit);
      this.modules.set(moduleRows(version.modules));
    } catch {
      this.failed.set(true);
    }
  }

  protected agentMetric(): string {
    const list = this.agents() ?? [];
    if (list.length === 0) return $localize`:@@settings.system.health.agent-none:Nenhum computador`;
    const connected = list.filter((agent) => agent.connected).length;
    return connected === list.length
      ? $localize`:@@settings.system.health.agent-ready:Ligado`
      : connected === 0
        ? $localize`:@@settings.system.health.agent-down:Off-line`
        : $localize`:@@settings.system.health.agent-partial:${connected}:count: de ${list.length}:total: ligados`;
  }

  protected agentDetail(): string {
    const list = this.agents() ?? [];
    return list.length === 1
      ? list[0].name
      : $localize`:@@settings.system.health.agent-count:${list.length}:count: computadores`;
  }

  protected tvMetric(): string {
    const list = this.tvs() ?? [];
    if (list.length === 0) return $localize`:@@settings.system.health.tv-none:Nenhuma TV`;
    const online = list.filter((tv) => tv.online).length;
    return online === list.length
      ? $localize`:@@settings.system.health.tv-ready:On-line`
      : online === 0
        ? $localize`:@@settings.system.health.tv-down:Sem conexão`
        : $localize`:@@settings.system.health.tv-partial:${online}:count: de ${list.length}:total: on-line`;
  }

  protected tvDetail(): string {
    const list = this.tvs() ?? [];
    return list.length === 1
      ? list[0].name
      : $localize`:@@settings.system.health.tv-count:${list.length}:count: TVs`;
  }

  protected apiMetric(): string {
    return $localize`:@@settings.system.health.api-ready:OK`;
  }

  protected agentTone(): 'ok' | 'bad' | '' {
    const list = this.agents() ?? [];
    if (list.length === 0) return '';
    const connected = list.filter((agent) => agent.connected).length;
    return connected === list.length ? 'ok' : connected === 0 ? 'bad' : '';
  }

  protected tvTone(): 'ok' | 'bad' | '' {
    const list = this.tvs() ?? [];
    if (list.length === 0) return '';
    const online = list.filter((tv) => tv.online).length;
    return online === list.length ? 'ok' : online === 0 ? 'bad' : '';
  }

  private async loadDeadLetters(): Promise<void> {
    this.deadLettersFailed.set(false);
    try {
      this.deadLetters.set(await this.system.deadLetters());
    } catch {
      this.deadLetters.set(null);
      this.deadLettersFailed.set(true);
    }
  }

  private async loadParity(): Promise<void> {
    try {
      this.parity.set(await this.system.parity());
    } catch {
      this.parity.set(null);
    }
  }

  /** Um bloco por computador pareado; o que não tem uso na janela fica com "—". */
  protected parityRows(): readonly ParityRow[] {
    const byAgent = new Map((this.parity()?.agents ?? []).map((item) => [item.agentId, item]));
    return (this.agents() ?? []).map((agent) => parityRow(agent, byAgent.get(agent.slug) ?? null));
  }

  protected parityWindow(): number {
    return this.parity()?.windowMinutes ?? 30;
  }

  protected deadMetric(): string {
    const report = this.deadLetters();
    if (!report) return $localize`:@@settings.system.health.dead-unknown:—`;
    if (report.total === 0) return $localize`:@@settings.system.health.dead-none:Nenhum`;
    return $localize`:@@settings.system.health.dead-count:${report.total}:count: falhos`;
  }

  protected deadTone(): 'ok' | 'bad' | '' {
    const report = this.deadLetters();
    if (!report) return '';
    return report.total === 0 && report.unavailableModules.length === 0 ? 'ok' : 'bad';
  }

  /** Módulo, tentativas, quando falhou e o tipo do último erro, numa linha só. Sem o conteúdo do evento. */
  protected deadItemDetail(item: DeadLetterEntry): string {
    const when = new Date(item.failedAt);
    const parts = [
      item.module,
      `${item.attempts}x`,
      Number.isNaN(when.getTime()) ? '' : this.dateFormat.format(when),
      item.lastError ?? '',
    ];
    return parts.filter((part) => part.length > 0).join(' · ');
  }

  protected versionMetric(): string {
    // O identificador completo da versão não cabe no cartão: os sete primeiros caracteres bastam para reconhecê-la.
    return this.commit()?.slice(0, 7) ?? $localize`:@@settings.system.health.version-none:—`;
  }
}

const NONE = '—';

/** Os números de um computador em texto curto; `null` (sem leitura ou sem uso) vira "—". */
export function parityRow(agent: HealthAgent, item: AgentParity | null): ParityRow {
  const direct = item?.directPercent ?? null;
  const lag = item?.loopLagP99Ms ?? null;
  return {
    slug: agent.slug,
    name: agent.name,
    direct: direct === null ? NONE : `${direct}%`,
    directTone: direct === null ? '' : direct >= PARITY_DIRECT_GOAL ? 'ok' : 'bad',
    reply: replyText(item),
    lag: lag === null ? NONE : `${lag} ms`,
    lagTone: lag === null ? '' : lag <= PARITY_LAG_GOAL_MS ? 'ok' : 'bad',
    unanswered:
      item === null
        ? NONE
        : item.unanswered === 0
          ? $localize`:@@settings.system.health.parity-unanswered-none:Nenhum`
          : String(item.unanswered),
    unansweredTone: item === null ? '' : item.unanswered === 0 ? 'ok' : 'bad',
  };
}

/** A mediana e o percentil 95, sem o jargão: "típico" e "lento". */
function replyText(item: AgentParity | null): string {
  if (item?.replyP50Ms == null || item.replyP95Ms == null) return NONE;
  return $localize`:@@settings.system.health.parity-reply-value:${item.replyP50Ms}:typical: ms típico · ${item.replyP95Ms}:slow: ms lento`;
}

/** O nome de cada módulo em português. Um módulo que a tela não conhece aparece com o próprio identificador. */
function moduleLabel(key: string): string {
  switch (key) {
    case 'identity':
      return $localize`:@@settings.system.health.module-identity:Identidade`;
    case 'devices':
      return $localize`:@@settings.system.health.module-devices:Dispositivos`;
    case 'tv':
      return $localize`:@@settings.system.health.module-tv:TV`;
    case 'training':
      return $localize`:@@settings.system.health.module-training:Treino`;
    case 'shopping':
      return $localize`:@@settings.system.health.module-shopping:Compras`;
    case 'web':
      return $localize`:@@settings.system.health.module-web:Site`;
    case 'agent':
      return $localize`:@@settings.system.health.module-agent:Programa do computador`;
    default:
      return key;
  }
}

/** As versões por módulo na ordem em que a API as manda; vazio quando a API ainda não as manda. */
function moduleRows(modules: Readonly<Record<string, string>> | undefined): readonly ModuleRow[] {
  return Object.entries(modules ?? {}).map(([key, version]) => ({
    key,
    label: moduleLabel(key),
    version,
  }));
}
