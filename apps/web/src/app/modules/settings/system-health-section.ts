import { Component, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { HealthAgent, SystemApi, TvItem } from './system-api';

/**
 * Leitura resumida do que já existe: a presença mais recente do agente, a TV vinculada e o commit da API. Não cria
 * telemetria nem tenta consultar a TV diretamente.
 */
@Component({
  selector: 'app-system-health-section',
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
  private readonly contactFormat = new Intl.DateTimeFormat('pt-BR', {
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

  protected agentState(agent: HealthAgent): string {
    return agent.connected
      ? $localize`:@@settings.system.health.agent-online:Agente on-line`
      : $localize`:@@settings.system.health.agent-offline:Agente off-line`;
  }

  protected lastSeen(agent: HealthAgent): string {
    return agent.lastSeenAt
      ? $localize`:@@settings.system.health.last-seen:Visto em ${this.contactFormat.format(new Date(agent.lastSeenAt))}:date:`
      : $localize`:@@settings.system.health.never-seen:Sem contato registrado`;
  }

  protected tvState(agent: HealthAgent): string {
    const tv = this.tvs()?.find((item) => item.agentSlug === agent.slug);
    if (!tv) return $localize`:@@settings.system.health.no-tv:Nenhuma TV vinculada`;
    return tv.online
      ? $localize`:@@settings.system.health.tv-online:${tv.name}:name:: on-line`
      : $localize`:@@settings.system.health.tv-offline:${tv.name}:name:: sem conexão`;
  }

  protected apiVersion(): string {
    const commit = this.commit();
    return commit
      ? $localize`:@@settings.system.health.version:API ${commit}:commit:`
      : $localize`:@@settings.system.health.version-unknown:Versão da API indisponível`;
  }
}
