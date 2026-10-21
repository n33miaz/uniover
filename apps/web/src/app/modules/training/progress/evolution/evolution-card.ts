import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { GoalRepository } from '../../data/goals/goal-repository';
import { type ExerciseSeries, ProgressRepository } from '../../data/progress/progress-repository';
import { SessionRepository } from '../../data/sessions/session-repository';
import type { ProgressPeriod } from '../../domain/progress/calendar';
import type { SeriesMetric } from '../../domain/progress/series';
import { formatDayMonth, formatKg } from '../../shell/format';
import { type ChipOption, TrainingChips } from '../../shell/training-chips';
import { TrainingGlyph } from '../../shell/training-glyph';
import { buildChartModel, type ChartRow } from '../charts/chart-model';
import type { ChartSpec } from '../charts/chart-types';
import { ProgressLineChart } from '../charts/line-chart';
import { GoalSheet } from '../goals/goal-sheet';
import {
  dayMonthOfKey,
  formatAxisKg,
  formatMonthYear,
  formatOneRepMax,
  periodName,
  signedKg,
} from '../progress-text';
import { ProgressGlyph } from '../progress-glyph';
import { ProgressSeg, type SegOption } from '../progress-seg';

/** O "chip" que abre a lista de todos os exercícios com histórico; nunca fica ligado. */
export const OTHER_EXERCISE = '__other';

let nextCardId = 0;

interface Loaded {
  /** O exercício e o período lidos (`id|período`): dado de outro exercício nunca aparece sob o nome de um novo. */
  readonly key: string;
  readonly series: ExerciseSeries;
  readonly now: number;
  /** O exercício tem algum registro (em qualquer período)? */
  readonly anyHistory: boolean;
}

type View = 'loading' | 'chart' | 'none' | 'period' | 'estimate';

/**
 * O cartão da evolução: a escolha do exercício (chips), a métrica (1RM estimado ou carga máxima), o gráfico de linha, o
 * período e, atrás de um toque, a tabela dos mesmos dados e a meta de 1RM. Abre em 1RM estimado nas últimas 8 semanas.
 *
 * Tudo vem do banco local (nada espera a rede). O gráfico é só desenho: o texto equivalente (rótulo falado, valor do ponto
 * escolhido e tabela) sai da mesma lista de linhas que o alimenta. Os quatro estados sem gráfico (carregando, sem
 * registro, nada no período, 1RM sem série que sirva) explicam o que falta em vez de mostrar um quadro vazio.
 */
@Component({
  selector: 'app-progress-evolution',
  imports: [
    RouterLink,
    TrainingChips,
    TrainingGlyph,
    ProgressGlyph,
    ProgressSeg,
    ProgressLineChart,
    GoalSheet,
  ],
  templateUrl: './evolution-card.html',
  styleUrl: './evolution-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressEvolution {
  private readonly progress = inject(ProgressRepository);
  private readonly goals = inject(GoalRepository);
  private readonly sessions = inject(SessionRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);

  /** O exercício do gráfico. */
  readonly exercise = input.required<{ readonly id: string; readonly name: string }>();
  readonly chips = input.required<readonly ChipOption[]>();
  readonly exerciseChange = output<string>();
  readonly pickOther = output<void>();

  protected readonly metric = signal<SeriesMetric>('oneRepMax');
  protected readonly period = signal<ProgressPeriod>('8w');
  /** O ponto que a pessoa escolheu (toque ou setas); `null` é o último. */
  protected readonly picked = signal<number | null>(null);
  protected readonly tableOpen = signal(false);
  protected readonly goalOpen = signal(false);
  /** A biblioteca de gráficos não pôde ser carregada: a tabela passa a ser o gráfico. */
  protected readonly chartFailed = signal(false);

  private readonly read = signal<Loaded | null>(null);
  private readonly goalRead = signal<{ readonly id: string; readonly value: number | null } | null>(
    null,
  );
  private ticket = 0;

  /** A leitura que vale para o exercício e o período de agora; enquanto a nova não chega, `null`. */
  private readonly loaded = computed(() => {
    const read = this.read();
    return read !== null && read.key === `${this.exercise().id}|${this.period()}` ? read : null;
  });
  private readonly goalKg = computed(() => {
    const goal = this.goalRead();
    return goal !== null && goal.id === this.exercise().id ? goal.value : null;
  });

  protected readonly tableId = `progress-table-${nextCardId++}`;
  protected readonly chipsLabel = $localize`:@@training.progress.exercise.label:Exercício do gráfico`;
  protected readonly metricLabel = $localize`:@@training.progress.metric.label:Métrica do gráfico`;
  protected readonly periodLabel = $localize`:@@training.progress.period.label:Período do gráfico`;
  protected readonly previousLabel = $localize`:@@training.progress.step.previous:Ponto anterior`;
  protected readonly nextLabel = $localize`:@@training.progress.step.next:Próximo ponto`;

  protected readonly metricOptions: readonly SegOption<SeriesMetric>[] = [
    { id: 'oneRepMax', label: $localize`:@@training.progress.metric.one-rep-max:1RM estimado` },
    { id: 'topWeight', label: $localize`:@@training.progress.metric.top-weight:Carga máxima` },
  ];
  protected readonly periodOptions: readonly SegOption<ProgressPeriod>[] = [
    { id: '8w', label: $localize`:@@training.progress.period.8w:8 semanas` },
    { id: '6m', label: $localize`:@@training.progress.period.6m:6 meses` },
    { id: 'all', label: $localize`:@@training.progress.period.all:Tudo` },
  ];

  protected readonly metricName = computed(() =>
    this.metric() === 'oneRepMax'
      ? $localize`:@@training.progress.metric.one-rep-max:1RM estimado`
      : $localize`:@@training.progress.metric.top-weight:Carga máxima`,
  );

  protected readonly model = computed(() => {
    const loaded = this.loaded();
    if (loaded === null) return null;
    return buildChartModel({
      points: loaded.series.points,
      metric: this.metric(),
      period: this.period(),
      now: loaded.now,
      goalKg: this.goalKg(),
    });
  });

  protected readonly view = computed<View>(() => {
    const loaded = this.loaded();
    const model = this.model();
    if (loaded === null || model === null) return 'loading';
    if (model.rows.length > 0) return 'chart';
    if (!loaded.anyHistory) return 'none';
    return loaded.series.points.length === 0 ? 'period' : 'estimate';
  });

  /** O ponto em destaque: o escolhido, ou o último. */
  protected readonly selectedIndex = computed<number | null>(() => {
    const count = this.model()?.rows.length ?? 0;
    if (count === 0) return null;
    const picked = this.picked();
    return picked !== null && picked < count ? picked : count - 1;
  });

  protected readonly spec = computed<ChartSpec | null>(() => {
    const model = this.model();
    if (model === null || model.rows.length === 0) return null;
    return {
      xs: model.xs,
      ys: model.ys,
      xRange: model.xRange,
      yRange: model.yRange,
      xTicks: model.xTicks,
      yTicks: model.yTicks,
      goal:
        model.goalKg === null
          ? null
          : {
              value: model.goalKg,
              label: $localize`:@@training.progress.goal.line:meta ${formatKg(model.goalKg)}:goal:`,
            },
      selected: this.selectedIndex(),
      formatX: model.longSpan ? formatMonthYear : (seconds) => formatDayMonth(seconds * 1000),
      formatY: formatAxisKg,
    };
  });

  /** O valor do ponto em destaque e quando foi. */
  protected readonly readout = computed(() => {
    const model = this.model();
    const index = this.selectedIndex();
    if (model === null || index === null) return null;
    const row = model.rows[index];
    const day = formatDayMonth(row.at);
    // Sem quebra dentro de "45 kg × 6": se faltar espaço, a carga inteira desce para a linha de baixo.
    const load = (
      row.topWeightKg === null
        ? ''
        : row.topWeightReps === null
          ? formatKg(row.topWeightKg)
          : `${formatKg(row.topWeightKg)} × ${row.topWeightReps}`
    ).replace(/ /g, ' ');
    const when =
      this.metric() === 'oneRepMax'
        ? $localize`:@@training.progress.readout.one-rep-max:${day}:day: · maior carga ${load}:load:`
        : row.topWeightReps === 1
          ? $localize`:@@training.progress.readout.top-weight-one:${day}:day: · 1 repetição`
          : $localize`:@@training.progress.readout.top-weight:${day}:day: · ${row.topWeightReps ?? 0}:reps: repetições`;
    const value = this.valueText(row);
    return { value, when, spoken: `${value}, ${when}` };
  });

  /** "+10,5 kg desde 29/08": quanto mudou do primeiro ao último ponto do período. */
  protected readonly delta = computed(() => {
    const series = this.loaded()?.series;
    if (!series || this.view() !== 'chart') return null;
    const delta = this.metric() === 'oneRepMax' ? series.oneRepMaxDelta : series.topWeightDelta;
    if (delta === null) return null;
    const amount = signedKg(delta.deltaKg);
    const since = dayMonthOfKey(delta.sinceDate);
    return {
      text: $localize`:@@training.progress.delta:${amount}:amount: desde ${since}:since:`,
      up: delta.deltaKg >= 0.05,
    };
  });

  /** O resumo falado do gráfico, que o leitor de tela lê no lugar do desenho. */
  protected readonly chartLabel = computed(() => {
    const model = this.model();
    if (model === null || model.rows.length === 0) return '';
    const name = this.exercise().name;
    const metric = this.metricName();
    const period = periodName(this.period());
    const first = model.rows[0];
    const last = model.rows[model.rows.length - 1];
    const goal = model.goalKg;
    const goalText = goal === null ? '' : formatKg(goal);
    const base =
      model.rows.length === 1
        ? $localize`:@@training.progress.chart.label-one:Gráfico de linha: ${metric}:metric: de ${name}:exercise: ${period}:period:. Um ponto: ${this.valueText(first)}:value: em ${formatDayMonth(first.at)}:day:.`
        : $localize`:@@training.progress.chart.label:Gráfico de linha: ${metric}:metric: de ${name}:exercise: ${period}:period:. ${model.rows.length}:count: pontos, de ${this.valueText(first)}:from: em ${formatDayMonth(first.at)}:fromDay: a ${this.valueText(last)}:to: em ${formatDayMonth(last.at)}:toDay:.`;
    return goal === null
      ? base
      : `${base} ${$localize`:@@training.progress.chart.label-goal:Meta de ${goalText}:goal:.`}`;
  });

  protected readonly tableCaption = computed(() => {
    const metric = this.metricName();
    const name = this.exercise().name;
    return $localize`:@@training.progress.table.caption:Dados do gráfico: ${metric}:metric: de ${name}:exercise:`;
  });

  /** As linhas da tabela: as mesmas do gráfico, da mais nova para a mais antiga. */
  protected readonly tableRows = computed(() => {
    const rows = this.model()?.rows ?? [];
    return [...rows].reverse().map((row) => ({
      key: row.date,
      day: formatDayMonth(row.at),
      value: this.valueText(row),
      extra:
        this.metric() === 'oneRepMax'
          ? row.topWeightKg === null
            ? ''
            : `${formatKg(row.topWeightKg)} × ${row.topWeightReps ?? 0}`
          : String(row.topWeightReps ?? 0),
    }));
  });

  protected readonly extraHeader = computed(() =>
    this.metric() === 'oneRepMax'
      ? $localize`:@@training.progress.table.heaviest:Maior carga do dia`
      : $localize`:@@training.progress.table.reps:Repetições`,
  );

  protected readonly goalValue = computed(() => this.goalKg());
  protected readonly goalButton = computed(() => {
    const goal = this.goalKg();
    return goal === null ? '' : formatKg(goal);
  });
  /** O nome falado do botão da meta: começa pelo texto visível ("Meta: 55 kg") e diz que abre a edição. */
  protected readonly goalEditLabel = computed(() => {
    const goal = this.goalButton();
    return $localize`:@@training.progress.goal.edit-label:Meta: ${goal}:goal:. Editar a meta`;
  });
  protected readonly pointCount = computed(() => this.model()?.rows.length ?? 0);
  protected readonly goalHeading = computed(() => {
    const name = this.exercise().name;
    return $localize`:@@training.progress.goal.heading-e1rm:Meta de 1RM · ${name}:exercise:`;
  });
  protected readonly goalField = $localize`:@@training.progress.goal.field-e1rm:Meta de 1RM, em kg`;

  protected readonly canStepBack = computed(() => (this.selectedIndex() ?? 0) > 0);
  protected readonly canStepForward = computed(() => {
    const count = this.model()?.rows.length ?? 0;
    return (this.selectedIndex() ?? 0) < count - 1;
  });

  constructor() {
    effect(() => {
      const id = this.exercise().id;
      const period = this.period();
      this.sessions.revision();
      untracked(() => void this.load(id, period));
    });
    effect(() => {
      const id = this.exercise().id;
      this.goals.revision();
      untracked(() => void this.loadGoal(id));
    });
  }

  protected onChip(id: string): void {
    if (id === OTHER_EXERCISE) this.pickOther.emit();
    else if (id !== this.exercise().id) this.exerciseChange.emit(id);
  }

  protected setMetric(metric: string): void {
    this.metric.set(metric as SeriesMetric);
    this.picked.set(null);
  }

  protected setPeriod(period: string): void {
    this.period.set(period as ProgressPeriod);
  }

  protected step(direction: -1 | 1): void {
    const index = this.selectedIndex();
    const count = this.model()?.rows.length ?? 0;
    if (index === null) return;
    this.picked.set(Math.min(count - 1, Math.max(0, index + direction)));
  }

  /**
   * Tenta carregar o gráfico de novo (a rede pode ter voltado): uma importação dinâmica que falhou não fica guardada com o
   * erro, então a segunda tentativa baixa o pedaço outra vez.
   */
  protected retryChart(): void {
    this.chartFailed.set(false);
  }

  protected onChartFailed(): void {
    this.chartFailed.set(true);
    this.tableOpen.set(true);
  }

  private valueText(row: ChartRow): string {
    return this.metric() === 'oneRepMax' ? formatOneRepMax(row.valueKg) : formatKg(row.valueKg);
  }

  private async load(id: string, period: ProgressPeriod): Promise<void> {
    const ticket = ++this.ticket;
    const now = this.runtime.now();
    const series = await this.progress.exerciseSeries(id, period, { now });
    let anyHistory = series.points.length > 0;
    if (!anyHistory && period !== 'all') {
      anyHistory = (await this.progress.exerciseSeries(id, 'all', { now })).points.length > 0;
    }
    if (ticket !== this.ticket) return;
    const key = `${id}|${period}`;
    if (key !== this.read()?.key) this.picked.set(null);
    this.read.set({ key, series, now, anyHistory });
  }

  private async loadGoal(id: string): Promise<void> {
    const value = await this.goals.value('exercise_e1rm', id);
    this.goalRead.set({ id, value });
  }
}
