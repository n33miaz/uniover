import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import {
  formatBytes,
  formatDaysAhead,
  formatHours,
  formatPercent,
  formatUptime,
  sparklinePoints,
} from './capacity-format';
import { CapacityBand, CapacityReport, SystemApi } from './system-api';

/** Uma barra do cartão: o que mede, quanto usa de quanto, a faixa e, quando é estimativa, o porquê em uma frase. */
interface Meter {
  readonly key: 'database' | 'memory' | 'hours';
  readonly label: string;
  readonly value: string;
  readonly percent: number;
  readonly band: CapacityBand;
  readonly estimate: string | null;
}

const SPARK_WIDTH = 200;
const SPARK_HEIGHT = 40;

/**
 * Capacidade (só do administrador): quanto do plano gratuito o app já usa. Banco e memória vêm do próprio servidor; as horas
 * do mês e o limite de RAM são estimativas e dizem isso. O que só o provedor sabe (horas de computação do Neon) aparece
 * como "Não medido" em vez de um número inventado. Nenhuma chamada a API de provedor: só o que o servidor já enxerga.
 */
@Component({
  selector: 'app-system-capacity-section',
  imports: [LoadingSkeleton],
  templateUrl: './system-capacity-section.html',
  styleUrl: './system-capacity-section.css',
})
export class SystemCapacitySection {
  private readonly system = inject(SystemApi);
  private readonly session = inject(SessionState);
  protected readonly report = signal<CapacityReport | null>(null);
  protected readonly failed = signal(false);
  protected readonly dismissing = signal(false);

  protected readonly meters = computed<readonly Meter[]>(() => {
    const report = this.report();
    if (!report) return [];
    const { database, server } = report;
    return [
      {
        key: 'database',
        label: $localize`:@@settings.system.capacity.database:Banco`,
        value: $localize`:@@settings.system.capacity.of:${formatBytes(database.bytes)}:used: de ${formatBytes(database.limitBytes)}:limit:`,
        percent: database.percent,
        band: database.band,
        estimate: $localize`:@@settings.system.capacity.database-note:Tamanho lógico do Postgres; o provedor pode medir um pouco diferente.`,
      },
      {
        key: 'memory',
        label: $localize`:@@settings.system.capacity.memory:Memória`,
        value: $localize`:@@settings.system.capacity.of:${formatBytes(server.workingSetBytes)}:used: de ${formatBytes(server.memoryLimitBytes)}:limit:`,
        percent: server.memoryPercent,
        band: server.memoryBand,
        estimate: $localize`:@@settings.system.capacity.memory-note:O limite de 512 MB vem das notas do projeto, não do provedor.`,
      },
      {
        key: 'hours',
        label: $localize`:@@settings.system.capacity.hours:Horas do Mês`,
        value: $localize`:@@settings.system.capacity.of:${formatHours(server.monthHours)}:used: de ${formatHours(server.hoursLimit)}:limit:`,
        percent: server.hoursPercent,
        band: server.hoursBand,
        estimate:
          server.servicesInWorkspace > 1
            ? $localize`:@@settings.system.capacity.hours-note-many:Dias corridos × 24 × ${server.servicesInWorkspace}:services: serviços. Projeção do mês: ${formatHours(server.hoursProjected)}:projected:.`
            : $localize`:@@settings.system.capacity.hours-note:Dias corridos × 24, como se o serviço ficasse sempre ligado.`,
      },
    ];
  });

  protected readonly series = computed(() =>
    (this.report()?.growth.points ?? []).map((p) => p.bytes),
  );
  protected readonly sparkline = computed(() =>
    sparklinePoints(this.series(), SPARK_WIDTH, SPARK_HEIGHT),
  );
  /** A última amostra, para o ponto da ponta (e para a curva de um dia só, que não tem linha). */
  protected readonly sparkEnd = computed(() => {
    const points = this.sparkline().split(' ').filter(Boolean);
    return points.length > 0 ? points[points.length - 1].split(',') : null;
  });

  constructor() {
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.report()) === null &&
        !untracked(() => this.failed())
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.failed.set(false);
    try {
      this.report.set(await this.system.capacity());
    } catch {
      this.failed.set(true);
    }
  }

  protected async dismiss(): Promise<void> {
    if (this.dismissing()) return;
    this.dismissing.set(true);
    try {
      await this.system.dismissCapacityAlerts();
      this.report.update((report) => (report ? { ...report, alerts: [] } : report));
    } catch {
      // O aviso continua à vista; o dono tenta de novo.
    } finally {
      this.dismissing.set(false);
    }
  }

  protected bandLabel(band: CapacityBand): string {
    return band === 'red'
      ? $localize`:@@settings.system.capacity.band-red:Crítico`
      : band === 'amber'
        ? $localize`:@@settings.system.capacity.band-amber:Atenção`
        : band === 'neutral'
          ? $localize`:@@settings.system.capacity.band-neutral:Informativo`
          : $localize`:@@settings.system.capacity.band-green:Folga`;
  }

  protected percentText(percent: number): string {
    return formatPercent(percent);
  }

  protected uptime(): string {
    return formatUptime(this.report()?.server.uptimeSeconds ?? 0);
  }

  protected bytes(value: number): string {
    return formatBytes(value);
  }

  protected metricName(metric: string): string {
    return metric === 'database'
      ? $localize`:@@settings.system.capacity.database:Banco`
      : metric === 'memory'
        ? $localize`:@@settings.system.capacity.memory:Memória`
        : $localize`:@@settings.system.capacity.hours:Horas do Mês`;
  }

  /** "Banco, Memória" quando mais de uma métrica passou do vermelho. */
  protected alertMetrics(): string {
    return (this.report()?.alerts ?? []).map((alert) => this.metricName(alert.metric)).join(', ');
  }

  protected tableName(schema: string, name: string): string {
    return `${schema}.${name}`;
  }

  protected growthState(): 'few' | 'flat' | 'growing' {
    return this.report()?.growth.state ?? 'few';
  }

  protected growthRate(): string {
    const rate = this.report()?.growth.bytesPerDay ?? 0;
    const text = formatBytes(Math.abs(rate));
    return rate >= 0
      ? $localize`:@@settings.system.capacity.rate-up:+${text}:rate: por dia`
      : $localize`:@@settings.system.capacity.rate-down:-${text}:rate: por dia`;
  }

  protected amberIn(): string {
    return formatDaysAhead(this.report()?.growth.daysToAmber);
  }

  protected redIn(): string {
    return formatDaysAhead(this.report()?.growth.daysToRed);
  }

  protected sparkLabel(): string {
    const count = this.series().length;
    return $localize`:@@settings.system.capacity.spark-label:Tamanho do banco nos últimos ${count}:count: dias com amostra`;
  }

  protected readonly sparkWidth = SPARK_WIDTH;
  protected readonly sparkHeight = SPARK_HEIGHT;
}
