import { Injectable, InjectionToken, type Provider, inject } from '@angular/core';
import { TRAINING_DB } from '../training-db';

/**
 * Uma seção da exportação em JSON. O serviço de exportação não conhece nenhuma: junta as que estiverem registradas no
 * token abaixo. Quem tem dados do usuário a exportar (corpo, refeições...) registra a sua seção com
 * `{ provide: TRAINING_EXPORT_SECTIONS, useClass: MinhaSecao, multi: true }`, **sem editar** o serviço.
 */
export interface ExportSection {
  /** Nome da seção no JSON (`sections.<key>`); único entre todas. */
  readonly key: string;
  /** Os dados da seção, só o que é do usuário e está vivo (sem lápide), com instantes em texto ISO. */
  build(): Promise<unknown>;
}

export const TRAINING_EXPORT_SECTIONS = new InjectionToken<readonly ExportSection[]>(
  'TRAINING_EXPORT_SECTIONS',
);

/** Milissegundos para texto ISO; `null` fica `null`. */
export function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Os exercícios próprios do dono (o catálogo vem do app e se recria sozinho, não precisa de cópia). */
@Injectable()
export class OwnExercisesSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'exercises';

  async build(): Promise<unknown> {
    const rows = await this.db.exercises.toArray();
    return rows
      .filter((row) => row.source === 'own' && row.deletedAt === null)
      .sort((a, b) => a.nameKey.localeCompare(b.nameKey))
      .map((row) => ({
        id: row.id,
        name: row.name,
        primaryMuscles: row.primaryMuscles,
        secondaryMuscles: row.secondaryMuscles,
        equipment: row.equipment,
        recordType: row.recordType,
        stepKg: row.stepKg,
        instructions: row.instructions,
        updatedAt: iso(row.clientUpdatedAt),
      }));
  }
}

@Injectable()
export class RoutinesSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'routines';

  async build(): Promise<unknown> {
    const rows = await this.db.routines.toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((row) => ({
        id: row.id,
        name: row.name,
        position: row.position,
        active: row.active,
        note: row.note === '' ? null : row.note,
        items: row.items.map((item) => ({
          id: item.id,
          exerciseId: item.exerciseId,
          position: item.position,
          targetSets: item.targetSets,
          repMin: item.repMin,
          repMax: item.repMax,
          restSeconds: item.restSeconds,
          supersetGroup: item.supersetGroup,
          note: item.note === '' ? null : item.note,
        })),
        updatedAt: iso(row.clientUpdatedAt),
      }));
  }
}

@Injectable()
export class SessionsSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'sessions';

  async build(): Promise<unknown> {
    const rows = await this.db.sessions.toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((row) => ({
        id: row.id,
        routineId: row.routineId,
        startedAt: iso(row.startedAt),
        finishedAt: iso(row.finishedAt),
        note: row.note === '' ? null : row.note,
        feeling: row.feeling,
        deviceId: row.deviceId,
      }));
  }
}

/** As séries vivas de treinos vivos. */
@Injectable()
export class SetsSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'sets';

  async build(): Promise<unknown> {
    const [sets, sessions] = await Promise.all([
      this.db.sets.toArray(),
      this.db.sessions.toArray(),
    ]);
    const dead = new Set(sessions.filter((row) => row.deletedAt !== null).map((row) => row.id));
    return sets
      .filter((row) => row.deletedAt === null && !dead.has(row.sessionId))
      .sort((a, b) => a.completedAt - b.completedAt || a.position - b.position)
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        exerciseId: row.exerciseId,
        position: row.position,
        setType: row.setType,
        weightKg: row.weightKg,
        reps: row.reps,
        durationS: row.durationS,
        rir: row.rir,
        rpe: row.rpe,
        note: row.note === '' ? null : row.note,
        completedAt: iso(row.completedAt),
      }));
  }
}

@Injectable()
export class GoalsSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'goals';

  async build(): Promise<unknown> {
    const rows = await this.db.goals.toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        kind: row.kind,
        exerciseId: row.exerciseId,
        value: row.value,
        updatedAt: iso(row.clientUpdatedAt),
      }));
  }
}

/** As seções que esta camada de dados registra. Seções de outras áreas entram pelo mesmo token, nos arquivos delas. */
export function provideExportSections(): Provider[] {
  return [
    { provide: TRAINING_EXPORT_SECTIONS, useClass: OwnExercisesSection, multi: true },
    { provide: TRAINING_EXPORT_SECTIONS, useClass: RoutinesSection, multi: true },
    { provide: TRAINING_EXPORT_SECTIONS, useClass: SessionsSection, multi: true },
    { provide: TRAINING_EXPORT_SECTIONS, useClass: SetsSection, multi: true },
    { provide: TRAINING_EXPORT_SECTIONS, useClass: GoalsSection, multi: true },
  ];
}
