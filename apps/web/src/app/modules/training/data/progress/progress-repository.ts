import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import {
  type MonthRange,
  type ProgressPeriod,
  type WeekRange,
  civilDateOf,
  deviceTimeZone,
  monthRange,
  periodRange,
  weekRange,
} from '../../domain/progress/calendar';
import { DEFAULT_ONE_RM_FORMULA, type OneRmFormula } from '../../domain/progress/one-rep-max';
import {
  type PersonalRecords,
  personalRecords,
  recordsInWindow,
} from '../../domain/progress/records';
import {
  type DailyPoint,
  type ProgressSet,
  type SeriesDelta,
  dailyBest,
  deltaSince,
} from '../../domain/progress/series';
import { type LoadSuggestion, suggestNextLoad } from '../../domain/progress/suggest-load';
import {
  type WeekExercise,
  type WeeklyVolume,
  weeklySetsByGroup,
} from '../../domain/progress/week-stats';
import { effectiveStepKg } from '../../domain/taxonomy';
import type { LocalSet } from '../sessions/session';
import { SessionRepository } from '../sessions/session-repository';
import { TRAINING_DB } from '../training-db';

/** Opções comuns: o fuso do aparelho, a fórmula do 1RM e o "agora" (todos com padrão; o teste troca). */
export interface ProgressOptions {
  readonly timeZone?: string;
  readonly formula?: OneRmFormula;
  readonly now?: number;
}

/** A série de um exercício no período: um ponto por dia, e quanto subiu da primeira à última marca. */
export interface ExerciseSeries {
  readonly points: readonly DailyPoint[];
  /** A diferença do 1RM estimado (o "+10,5 kg desde 29/08"); `null` com menos de duas marcas. */
  readonly oneRepMaxDelta: SeriesDelta | null;
  /** A diferença da carga máxima. */
  readonly topWeightDelta: SeriesDelta | null;
}

export interface WeekVolume {
  readonly week: WeekRange;
  readonly volume: WeeklyVolume;
}

export interface MonthCalendar {
  /** Dias do mês (de 1 em diante) com treino. */
  readonly days: readonly number[];
  readonly daysInMonth: number;
  /** O dia de hoje, se `now` cai neste mês. */
  readonly today: number | null;
}

/** Os recordes de carga máxima e 1RM batidos na semana, por exercício. */
export interface WeekRecord {
  readonly exerciseId: string;
  readonly exerciseName: string;
  readonly kinds: readonly ('maxWeight' | 'oneRepMax')[];
}

export interface WeekSummary {
  readonly week: WeekRange;
  /** Treinos da semana (sem contar os que só tiveram aquecimento). */
  readonly sessions: number;
  /** Séries de trabalho da semana (aquecimento não conta). */
  readonly workingSets: number;
  /** Σ carga × repetições das séries de trabalho, em kg (halteres contam a carga de um halter). */
  readonly volumeKg: number;
  readonly volume: WeeklyVolume;
  readonly records: readonly WeekRecord[];
}

/** O que a sugestão precisa saber do item da rotina. */
export interface SuggestionTarget {
  readonly exerciseId: string;
  readonly repMin: number;
  readonly repMax: number;
}

/**
 * Consultas do progresso: **só leitura** do banco local. Nada é gravado: carga por dia, 1RM, recordes, volume e frequência
 * são derivados das séries e se recalculam a cada pergunta, então não há o que sincronizar nem o que ficar velho.
 *
 * Entram as séries vivas (sem lápide) de treinos vivos, inclusive o que ainda está aberto (o treino de hoje aparece no
 * gráfico assim que a série é concluída). O fuso e a fórmula são parâmetros; o padrão é o fuso do aparelho e Epley.
 */
@Injectable()
export class ProgressRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly sessions = inject(SessionRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);

  /** Carga e 1RM por dia de um exercício no período (`8w`, `6m` ou `all`). */
  async exerciseSeries(
    exerciseId: string,
    period: ProgressPeriod,
    options: ProgressOptions = {},
  ): Promise<ExerciseSeries> {
    const { from, to } = periodRange(period, this.now(options), this.zone(options));
    const sets = (await this.exerciseSets(exerciseId)).filter(
      (set) => (from === null || set.completedAt >= from) && set.completedAt <= to,
    );
    const points = dailyBest(sets, this.zone(options), this.formula(options));
    return {
      points,
      oneRepMaxDelta: deltaSince(points, 'oneRepMax'),
      topWeightDelta: deltaSince(points, 'topWeight'),
    };
  }

  /** Os recordes do exercício em todo o histórico. */
  async records(exerciseId: string, options: ProgressOptions = {}): Promise<PersonalRecords> {
    return personalRecords(await this.exerciseSets(exerciseId), this.formula(options));
  }

  /** Séries de trabalho por grupo e por músculo na semana que contém `weekStart`. */
  async weekVolume(weekStart: number, options: ProgressOptions = {}): Promise<WeekVolume> {
    const zone = this.zone(options);
    const week = weekRange(weekStart, zone);
    const sets = await this.setsBetween(week.start, week.end);
    const exercises = await this.exerciseMap(sets.map((set) => set.exerciseId));
    return { week, volume: weeklySetsByGroup(sets, exercises, week.start, zone) };
  }

  /** O calendário do mês: os dias com treino e o dia de hoje. */
  async monthCalendar(
    month: { readonly year: number; readonly month: number },
    options: ProgressOptions = {},
  ): Promise<MonthCalendar> {
    const zone = this.zone(options);
    const range: MonthRange = monthRange(month.year, month.month, zone);
    const trained = await this.trainedSessions(range.start, range.end);
    const days = new Set<number>();
    for (const session of trained) days.add(civilDateOf(session.startedAt, zone).day);

    const today = civilDateOf(this.now(options), zone);
    return {
      days: [...days].sort((a, b) => a - b),
      daysInMonth: range.daysInMonth,
      today: today.year === month.year && today.month === month.month ? today.day : null,
    };
  }

  /**
   * O resumo da semana que contém `now`: treinos, séries, volume e os recordes batidos (carga máxima e 1RM), para o
   * texto de compartilhar e para a tela.
   */
  async weekSummary(options: ProgressOptions = {}): Promise<WeekSummary> {
    const zone = this.zone(options);
    const formula = this.formula(options);
    const week = weekRange(this.now(options), zone);
    const sets = await this.setsBetween(week.start, week.end);
    const working = sets.filter((set) => set.setType !== 'warmup');

    const exerciseIds = [...new Set(working.map((set) => set.exerciseId))];
    const exercises = await this.db.exercises.bulkGet(exerciseIds);
    const byId = new Map<string, WeekExercise>();
    const names = new Map<string, string>();
    exerciseIds.forEach((id, index) => {
      const exercise = exercises[index];
      if (exercise) {
        byId.set(id, { primaryMuscles: exercise.primaryMuscles });
        names.set(id, exercise.name);
      }
    });

    let volumeKg = 0;
    for (const set of working) {
      if (set.weightKg !== null && set.reps !== null && set.weightKg > 0 && set.reps > 0) {
        volumeKg += set.weightKg * set.reps;
      }
    }

    const records: WeekRecord[] = [];
    for (const exerciseId of exerciseIds) {
      const kinds = recordsInWindow(
        await this.exerciseSets(exerciseId),
        week.start,
        week.end,
        formula,
      );
      if (kinds.length > 0) {
        records.push({ exerciseId, exerciseName: names.get(exerciseId) ?? '', kinds });
      }
    }
    records.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));

    return {
      week,
      sessions: (await this.trainedSessions(week.start, week.end)).length,
      workingSets: working.length,
      volumeKg: Math.round(volumeKg * 100) / 100,
      volume: weeklySetsByGroup(sets, byId, week.start, zone),
      records,
    };
  }

  /**
   * A sugestão de carga do item da rotina, a partir da última vez que o exercício foi feito num treino encerrado. O salto
   * é o do exercício (o escolhido pelo dono ou o do equipamento). Sem histórico, `reason: 'no-history'`.
   */
  async lastLoadSuggestion(target: SuggestionTarget): Promise<LoadSuggestion> {
    const exercise = await this.db.exercises.get(target.exerciseId);
    const last = await this.sessions.lastPerformance(target.exerciseId);
    return suggestNextLoad({
      lastSets: last?.sets ?? [],
      repMin: target.repMin,
      repMax: target.repMax,
      stepKg: exercise ? effectiveStepKg(exercise) : 0,
    });
  }

  private now(options: ProgressOptions): number {
    return options.now ?? this.runtime.now();
  }

  private zone(options: ProgressOptions): string {
    return options.timeZone ?? deviceTimeZone();
  }

  private formula(options: ProgressOptions): OneRmFormula {
    return options.formula ?? DEFAULT_ONE_RM_FORMULA;
  }

  /** As séries vivas de um exercício, de treinos vivos. */
  private async exerciseSets(exerciseId: string): Promise<ProgressSet[]> {
    const rows = await this.db.sets.where('exerciseId').equals(exerciseId).toArray();
    return this.liveSets(rows);
  }

  /** As séries vivas concluídas entre `from` (inclusive) e `to` (exclusive), de treinos vivos. */
  private async setsBetween(from: number, to: number): Promise<LocalSet[]> {
    const rows = await this.db.sets.where('completedAt').between(from, to, true, false).toArray();
    return this.liveRows(rows);
  }

  private async liveRows(rows: readonly LocalSet[]): Promise<LocalSet[]> {
    const live = rows.filter((row) => row.deletedAt === null);
    const sessionIds = [...new Set(live.map((row) => row.sessionId))];
    const found = await this.db.sessions.bulkGet(sessionIds);
    const dead = new Set<string>();
    sessionIds.forEach((id, index) => {
      const session = found[index];
      if (session !== undefined && session.deletedAt !== null) dead.add(id);
    });
    return live.filter((row) => !dead.has(row.sessionId));
  }

  private async liveSets(rows: readonly LocalSet[]): Promise<ProgressSet[]> {
    return (await this.liveRows(rows)).map((row) => ({
      sessionId: row.sessionId,
      setType: row.setType,
      weightKg: row.weightKg,
      reps: row.reps,
      completedAt: row.completedAt,
    }));
  }

  private async exerciseMap(ids: readonly string[]): Promise<Map<string, WeekExercise>> {
    const unique = [...new Set(ids)];
    const found = await this.db.exercises.bulkGet(unique);
    const map = new Map<string, WeekExercise>();
    unique.forEach((id, index) => {
      const exercise = found[index];
      if (exercise) map.set(id, { primaryMuscles: exercise.primaryMuscles });
    });
    return map;
  }

  /** Treinos vivos que começaram na janela e têm ao menos uma série de trabalho viva (só aquecimento não é treino). */
  private async trainedSessions(from: number, to: number) {
    const sessions = (
      await this.db.sessions.where('startedAt').between(from, to, true, false).toArray()
    ).filter((session) => session.deletedAt === null);
    if (sessions.length === 0) return [];
    const sets = await this.db.sets
      .where('sessionId')
      .anyOf(sessions.map((session) => session.id))
      .toArray();
    const withWork = new Set(
      sets
        .filter((set) => set.deletedAt === null && set.setType !== 'warmup')
        .map((set) => set.sessionId),
    );
    return sessions.filter((session) => withWork.has(session.id));
  }
}
