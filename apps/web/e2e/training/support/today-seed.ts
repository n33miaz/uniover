import { type TrainingServer, dotnetInstant } from './training-server';
import { SEED_EXERCISE_IDS } from './training-seed';

/**
 * Dados-semente da aba Hoje: treinos antigos (para a "última vez", a sugestão e os recordes) e um treino aberto em outro
 * aparelho. Os ids são fixos e nascem do relógio do teste, que é o mesmo (no começo) do relógio da página.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const OTHER_DEVICE = 'aparelho-do-outro-celular';
export const OPEN_ELSEWHERE_ID = '30000000-0000-4000-8000-0000000000ff';

const sessionId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const setId = (n: number, index: number) =>
  `40000000-0000-4000-8000-${String(n * 100 + index).padStart(12, '0')}`;

export interface PastSet {
  readonly exerciseId: string;
  readonly weightKg: number;
  readonly reps: number;
  readonly rpe?: number;
}

/**
 * Um treino já encerrado, de outro aparelho, aberto há `ageMs`, sem rotina (a sequência segue na primeira). O `updatedAt`
 * fica de fora de propósito: é o relógio do SERVIDOR e o `seed` o carimba com o agora dele. Com a data do treino (dias
 * atrás), um treino semeado depois da primeira leitura ficaria atrás do cursor e nunca seria puxado.
 */
export function seedPastWorkout(
  server: TrainingServer,
  number: number,
  ageMs: number,
  sets: readonly PastSet[],
): void {
  const startedAt = Date.now() - ageMs;
  const at = dotnetInstant(startedAt);
  server.seed('sessions', [
    {
      id: sessionId(number),
      routineId: null,
      startedAt: at,
      finishedAt: dotnetInstant(startedAt + 50 * 60_000),
      note: null,
      feeling: null,
      deviceId: OTHER_DEVICE,
      clientUpdatedAt: at,
      deleted: false,
    },
  ]);
  server.seed(
    'sets',
    sets.map((set, index) => {
      const completedAt = dotnetInstant(startedAt + (index + 1) * 3 * 60_000);
      return {
        id: setId(number, index),
        sessionId: sessionId(number),
        exerciseId: set.exerciseId,
        position: index,
        setType: 'work',
        weightKg: set.weightKg,
        reps: set.reps,
        durationS: null,
        rir: null,
        rpe: set.rpe ?? null,
        note: null,
        completedAt,
        clientUpdatedAt: completedAt,
        deleted: false,
      };
    }),
  );
}

/**
 * Supino reto com barra: 4 séries de 40 kg com 10 repetições (o topo da faixa 6–10 da rotina A). A sugestão sobe para
 * 42,5 kg × 6–8, e a série de 42,5 kg × 8 bate o recorde de carga máxima (antes 40 kg).
 */
export function seedBenchHistory(server: TrainingServer): void {
  seedPastWorkout(
    server,
    1,
    3 * DAY,
    [0, 1, 2, 3].map(() => ({ exerciseId: SEED_EXERCISE_IDS.bench, weightKg: 40, reps: 10 })),
  );
}

/** Um treino que ficou aberto em outro aparelho, aberto há `ageMs`. */
export function seedOpenElsewhere(server: TrainingServer, ageMs: number): void {
  const startedAt = Date.now() - ageMs;
  const at = dotnetInstant(startedAt);
  server.seed('sessions', [
    {
      id: OPEN_ELSEWHERE_ID,
      routineId: null,
      startedAt: at,
      finishedAt: null,
      note: null,
      feeling: null,
      deviceId: OTHER_DEVICE,
      clientUpdatedAt: at,
      deleted: false,
    },
  ]);
}

export const HOURS = { one: HOUR, thirteen: 13 * HOUR, three: 3 * HOUR };

/** Uma terceira rotina com supersérie (supino e tríceps na polia, sem descanso entre o par), para a captura da supersérie. */
export function seedSupersetRoutine(server: TrainingServer): void {
  const at = '2026-10-02T10:00:00.0000000+00:00';
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  server.seed('routines', [
    {
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Treino C · Superséries',
      position: 2,
      active: true,
      note: null,
      items: [
        [SEED_EXERCISE_IDS.bench, 3, 6, 10, 120],
        [id(11), 3, 10, 15, 60],
      ].map(([exerciseId, sets, repMin, repMax, rest], index) => ({
        id: `20000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
        exerciseId,
        position: index,
        targetSets: sets,
        repMin,
        repMax,
        restSeconds: rest,
        supersetGroup: 1,
        note: null,
      })),
      updatedAt: at,
      clientUpdatedAt: at,
      deleted: false,
    },
  ]);
}
