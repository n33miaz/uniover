import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { GoalRepository } from '../../data/goals/goal-repository';
import { ProgressRepository, type WeekSummary } from '../../data/progress/progress-repository';
import { SessionRepository } from '../../data/sessions/session-repository';
import { deviceTimeZone } from '../../domain/progress/calendar';
import type { WeeklyVolume } from '../../domain/progress/week-stats';
import { MUSCLE_GROUP_IDS, type MuscleGroupId, muscleGroupLabel } from '../../domain/taxonomy';
import { weekAt } from '../calendar-nav';
import { GoalSheet } from '../goals/goal-sheet';
import { ProgressGlyph } from '../progress-glyph';
import { ProgressSection } from '../progress-section';
import { weekLabel } from '../progress-text';

export interface GroupBar {
  readonly id: MuscleGroupId;
  readonly label: string;
  readonly sets: number;
  /** Largura da barra, de 0 a 100: relativa ao grupo mais treinado da semana. */
  readonly percent: number;
}

/**
 * Uma barra por grupo muscular, na ordem da taxonomia. O tamanho é relativo ao grupo mais treinado (a barra mais longa
 * ocupa a linha toda), e o número real vai ao lado: a barra compara, o número informa. Semana sem série: barras vazias.
 */
export function groupBars(volume: WeeklyVolume): GroupBar[] {
  const most = Math.max(0, ...MUSCLE_GROUP_IDS.map((id) => volume.byGroup[id]));
  return MUSCLE_GROUP_IDS.map((id) => {
    const sets = volume.byGroup[id];
    return {
      id,
      label: muscleGroupLabel(id),
      sets,
      percent: most === 0 ? 0 : Math.round((sets / most) * 1000) / 10,
    };
  });
}

const sessionsText = (count: number) =>
  count === 1
    ? $localize`:@@training.progress.week.sessions-one:1 treino`
    : $localize`:@@training.progress.week.sessions-many:${count}:count: treinos`;

const setsText = (count: number) =>
  count === 1
    ? $localize`:@@training.progress.week.sets-one:1 série`
    : $localize`:@@training.progress.week.sets-many:${count}:count: séries`;

/**
 * "3 treinos · 54 séries" ou, com a meta de treinos por semana, "3 de 4 treinos · 54 séries". Semana sem treino:
 * "Nenhum treino nesta semana". A meta só aparece quando o dono a definiu.
 */
export function weekLine(sessions: number, sets: number, goal: number | null): string {
  if (sessions === 0 && sets === 0) {
    return $localize`:@@training.progress.week.none:Nenhum treino nesta semana`;
  }
  const trained =
    goal === null
      ? sessionsText(sessions)
      : $localize`:@@training.progress.week.sessions-goal:${sessions}:count: de ${goal}:goal: treinos`;
  const sets_ = setsText(sets);
  return $localize`:@@training.progress.week.line:${trained}:sessions: · ${sets_}:sets:`;
}

interface Read {
  readonly offset: number;
  readonly summary: WeekSummary;
  /** Séries de trabalho da semana anterior à que se vê, para comparar. */
  readonly previousSets: number;
}

/**
 * O volume da semana: treinos e séries (contra a meta de treinos por semana, quando há), uma barra por grupo muscular e a
 * semana anterior para comparar. A semana vai de segunda a domingo e se navega de uma em uma. O app mostra, não
 * recomenda quantas séries fazer. A meta de treinos por semana também é definida aqui.
 */
@Component({
  selector: 'app-progress-week',
  imports: [ProgressSection, ProgressGlyph, GoalSheet],
  templateUrl: './week-section.html',
  styleUrl: './week-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressWeek {
  private readonly progress = inject(ProgressRepository);
  private readonly goals = inject(GoalRepository);
  private readonly sessions = inject(SessionRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);

  protected readonly heading = $localize`:@@training.progress.week.title:Semana`;
  protected readonly open = signal(false);
  protected readonly goalOpen = signal(false);
  /** 0 é a semana de hoje; -1, a anterior; e assim por diante. */
  protected readonly offset = signal(0);
  protected readonly previousLabel = $localize`:@@training.progress.week.previous:Semana anterior`;
  protected readonly nextLabel = $localize`:@@training.progress.week.next:Próxima semana`;
  protected readonly barsLabel = $localize`:@@training.progress.week.bars-label:Séries de trabalho por grupo muscular`;
  protected readonly goalHeading = $localize`:@@training.progress.week.goal-title:Meta de treinos por semana`;
  protected readonly goalField = $localize`:@@training.progress.week.goal-field:Treinos por semana`;

  private readonly read = signal<Read | null>(null);
  private readonly goal = signal<number | null>(null);
  private ticket = 0;

  protected readonly goalValue = this.goal.asReadonly();
  protected readonly viewed = computed(() => {
    const read = this.read();
    return read !== null && read.offset === this.offset() ? read : null;
  });

  /** O que a linha fechada diz: sempre a semana de hoje. */
  protected readonly summary = computed(() => {
    const read = this.read();
    if (read === null || read.offset !== 0) return '';
    return weekLine(read.summary.sessions, read.summary.workingSets, this.goal());
  });

  protected readonly range = computed(() => {
    const viewed = this.viewed();
    if (viewed === null) return '';
    return weekLabel(viewed.summary.week.startKey, viewed.summary.week.endKey);
  });

  protected readonly relative = computed(() => {
    switch (this.offset()) {
      case 0:
        return $localize`:@@training.progress.week.this:Esta semana`;
      case -1:
        return $localize`:@@training.progress.week.last:Semana passada`;
      default:
        return '';
    }
  });

  protected readonly line = computed(() => {
    const viewed = this.viewed();
    if (viewed === null) return '';
    return weekLine(viewed.summary.sessions, viewed.summary.workingSets, this.goal());
  });

  protected readonly previous = computed(() => {
    const viewed = this.viewed();
    if (viewed === null) return '';
    const sets = viewed.previousSets;
    return sets === 0
      ? $localize`:@@training.progress.week.previous-none:Semana anterior: nenhuma série`
      : $localize`:@@training.progress.week.previous-sets:Semana anterior: ${setsText(sets)}:sets:`;
  });

  protected readonly bars = computed(() => {
    const viewed = this.viewed();
    return viewed === null ? [] : groupBars(viewed.summary.volume);
  });

  /** Séries de exercícios que o aparelho não sabe agrupar: contam no total, em nenhuma barra. */
  protected readonly unclassified = computed(() => this.viewed()?.summary.volume.unclassified ?? 0);

  protected readonly goalText = computed(() => {
    const goal = this.goal();
    return goal === null
      ? $localize`:@@training.progress.week.goal-none:Sem meta: você define`
      : $localize`:@@training.progress.week.goal-value:${goal}:goal: por semana`;
  });

  constructor() {
    effect(() => {
      const offset = this.offset();
      this.sessions.revision();
      untracked(() => void this.load(offset));
    });
    effect(() => {
      this.goals.revision();
      untracked(() => void this.loadGoal());
    });
    // Fechada, a seção volta para a semana de hoje: a linha fechada sempre fala da semana atual.
    effect(() => {
      if (!this.open()) untracked(() => this.offset.set(0));
    });
  }

  protected move(delta: -1 | 1): void {
    this.offset.update((offset) => Math.min(0, offset + delta));
  }

  private async load(offset: number): Promise<void> {
    const ticket = ++this.ticket;
    const now = this.runtime.now();
    const zone = deviceTimeZone();
    const week = weekAt(now, offset, zone);
    const before = weekAt(now, offset - 1, zone);
    const [summary, previous] = await Promise.all([
      this.progress.weekSummary({ now: week.start, timeZone: zone }),
      this.progress.weekVolume(before.start, { timeZone: zone }),
    ]);
    if (ticket !== this.ticket) return;
    this.read.set({ offset, summary, previousSets: previous.volume.total });
  }

  private async loadGoal(): Promise<void> {
    this.goal.set(await this.goals.value('weekly_sessions'));
  }
}
