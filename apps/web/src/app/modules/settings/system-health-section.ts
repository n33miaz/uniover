import { Component, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { DeadLetterEntry, DeadLetterReport, HealthAgent, SystemApi, TvItem } from './system-api';

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
  protected readonly failed = signal(false);
  /** Os eventos internos que esgotaram as tentativas. `null` até chegar; fica `null` se a leitura falhar (o resto da Saúde segue). */
  protected readonly deadLetters = signal<DeadLetterReport | null>(null);
  protected readonly deadLettersFailed = signal(false);
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
    try {
      const [agents, tvs, version] = await Promise.all([
        this.system.agents(),
        this.system.tvs(),
        this.system.deploymentVersion(),
      ]);
      this.agents.set(agents);
      this.tvs.set(tvs);
      this.commit.set(version.commit);
    } catch {
      this.failed.set(true);
    }
  }

  protected agentMetric(): string {
    const list = this.agents() ?? [];
    if (list.length === 0) return $localize`:@@settings.system.health.agent-none:Nenhum agente`;
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
    // O identificador completo do commit não cabe no cartão: os sete primeiros caracteres bastam para reconhecê-lo.
    return this.commit()?.slice(0, 7) ?? $localize`:@@settings.system.health.version-none:—`;
  }
}
