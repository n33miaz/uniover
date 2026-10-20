import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { dateKey, deviceTimeZone } from '../../domain/progress/calendar';
import type { WeekRecord, WeekSummary } from '../progress/progress-repository';
import { TRAINING_DB } from '../training-db';
import { type CsvColumn, buildCsv } from './csv';
import { ExportDelivery, type ShareOutcome } from './export-delivery';
import { type ExportSection, TRAINING_EXPORT_SECTIONS } from './export-sections';

/** Versão do formato do arquivo JSON: sobe quando o formato muda de um jeito que quem lê precisa saber. */
export const EXPORT_VERSION = 1;

/** O arquivo JSON da exportação. */
export interface ExportDocument {
  readonly app: string;
  readonly module: string;
  readonly exportVersion: number;
  /** Instante da exportação, em texto ISO. */
  readonly exportedAt: string;
  readonly sections: Readonly<Record<string, unknown>>;
}

/** As colunas do CSV de séries, nesta ordem. As numéricas não passam pela proteção contra fórmula. */
export const SETS_CSV_COLUMNS: readonly CsvColumn[] = [
  { key: 'date' },
  { key: 'session_id' },
  { key: 'routine' },
  { key: 'exercise' },
  { key: 'set_type' },
  { key: 'weight_kg', numeric: true },
  { key: 'reps', numeric: true },
  { key: 'duration_s', numeric: true },
  { key: 'rir', numeric: true },
  { key: 'rpe', numeric: true },
  { key: 'note' },
];

export interface ExportOptions {
  /** Fuso para a coluna `date` do CSV; o padrão é o do aparelho. */
  readonly timeZone?: string;
}

/**
 * Exportação dos dados do Treino: JSON com tudo, CSV só das séries e o texto do resumo da semana. É o seguro contra o
 * navegador apagar os dados do site e o jeito de levar o histórico para outro lugar. **Não há importação** (restaurar de
 * arquivo) nesta versão.
 *
 * As seções do JSON vêm do token `TRAINING_EXPORT_SECTIONS`: o serviço junta as que estiverem registradas, e quem tem
 * dados novos registra a sua sem editar este arquivo.
 */
@Injectable()
export class ExportService {
  private readonly db = inject(TRAINING_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly delivery = inject(ExportDelivery);
  private readonly sections: readonly ExportSection[] =
    inject(TRAINING_EXPORT_SECTIONS, { optional: true }) ?? [];

  /** O JSON com todas as seções registradas. Duas seções com o mesmo nome são um erro de programação. */
  async buildJson(): Promise<ExportDocument> {
    const sections: Record<string, unknown> = {};
    for (const section of this.sections) {
      if (Object.prototype.hasOwnProperty.call(sections, section.key)) {
        throw new Error(`Duas seções de exportação com o mesmo nome: ${section.key}`);
      }
      sections[section.key] = await section.build();
    }
    return {
      app: 'uniover',
      module: 'training',
      exportVersion: EXPORT_VERSION,
      exportedAt: new Date(this.runtime.now()).toISOString(),
      sections,
    };
  }

  /** O CSV das séries vivas de treinos vivos, da mais antiga à mais nova. */
  async buildSetsCsv(options: ExportOptions = {}): Promise<string> {
    const zone = options.timeZone ?? deviceTimeZone();
    const [sets, sessions, routines, exercises] = await Promise.all([
      this.db.sets.toArray(),
      this.db.sessions.toArray(),
      this.db.routines.toArray(),
      this.db.exercises.toArray(),
    ]);
    const sessionById = new Map(sessions.map((row) => [row.id, row]));
    const routineName = new Map(routines.map((row) => [row.id, row.name]));
    const exerciseName = new Map(exercises.map((row) => [row.id, row.name]));

    const rows = sets
      .filter((set) => {
        const session = sessionById.get(set.sessionId);
        return set.deletedAt === null && (session === undefined || session.deletedAt === null);
      })
      .sort((a, b) => a.completedAt - b.completedAt || a.position - b.position)
      .map((set) => {
        const routineId = sessionById.get(set.sessionId)?.routineId ?? null;
        return {
          date: dateKey(set.completedAt, zone),
          session_id: set.sessionId,
          routine: routineId === null ? '' : (routineName.get(routineId) ?? ''),
          exercise: exerciseName.get(set.exerciseId) ?? '',
          set_type: set.setType,
          weight_kg: set.weightKg,
          reps: set.reps,
          duration_s: set.durationS,
          rir: set.rir,
          rpe: set.rpe,
          note: set.note,
        };
      });
    return buildCsv(SETS_CSV_COLUMNS, rows);
  }

  /** O texto do resumo da semana (treinos, séries, volume e recordes), pronto para compartilhar. */
  weekSummaryText(week: WeekSummary, goalPerWeek: number | null = null): string {
    const range = `${shortDate(week.week.startKey)} a ${shortDate(week.week.endKey)}`;
    const sessions =
      goalPerWeek === null
        ? $localize`:@@training.export.week.sessions:Treinos: ${week.sessions}:count:`
        : $localize`:@@training.export.week.sessionsGoal:Treinos: ${week.sessions}:count: de ${goalPerWeek}:goal: (meta)`;
    const volume = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(
      week.volumeKg,
    );
    const records =
      week.records.length === 0
        ? $localize`:@@training.export.week.noRecords:Recordes: nenhum nesta semana`
        : $localize`:@@training.export.week.records:Recordes: ${week.records.map(recordText).join('; ')}:list:`;

    return [
      $localize`:@@training.export.week.title:Treino: resumo da semana de ${range}:range:`,
      sessions,
      $localize`:@@training.export.week.sets:Séries de trabalho: ${week.workingSets}:count:`,
      $localize`:@@training.export.week.volume:Volume: ${volume}:kg: kg`,
      records,
    ].join('\n');
  }

  /** Baixa o JSON completo. Devolve o nome do arquivo. */
  async downloadJson(options: ExportOptions = {}): Promise<string> {
    const text = JSON.stringify(await this.buildJson(), null, 2);
    const filename = this.filename('json', options);
    this.delivery.download(new Blob([text], { type: 'application/json' }), filename);
    return filename;
  }

  /** Baixa o CSV das séries. Devolve o nome do arquivo. */
  async downloadSetsCsv(options: ExportOptions = {}): Promise<string> {
    const text = await this.buildSetsCsv(options);
    const filename = this.filename('csv', options);
    this.delivery.download(new Blob([text], { type: 'text/csv;charset=utf-8' }), filename);
    return filename;
  }

  /** Compartilha o resumo da semana como texto (o compartilhar do sistema; sem ele, copia). */
  shareWeekSummary(week: WeekSummary, goalPerWeek: number | null = null): Promise<ShareOutcome> {
    return this.delivery.share({
      title: $localize`:@@training.export.week.shareTitle:Resumo da semana`,
      text: this.weekSummaryText(week, goalPerWeek),
    });
  }

  private filename(extension: string, options: ExportOptions): string {
    const day = dateKey(this.runtime.now(), options.timeZone ?? deviceTimeZone());
    return `uniover-treino-${day}.${extension}`;
  }
}

/** `2026-10-12` vira `12/10`. */
function shortDate(key: string): string {
  const [, month, day] = key.split('-');
  return `${day}/${month}`;
}

function recordText(record: WeekRecord): string {
  const kinds = record.kinds.map((kind) =>
    kind === 'maxWeight'
      ? $localize`:@@training.export.week.recordMaxWeight:carga máxima`
      : $localize`:@@training.export.week.recordOneRepMax:1RM estimado`,
  );
  return `${record.exerciseName} (${kinds.join(', ')})`;
}
