import { SEED_EXERCISE_IDS } from './support/training-seed';
import { type Row, type TrainingServer, dotnetInstant } from './support/training-server';

/**
 * Histórico de treinos para os testes da tela de Progresso: doze treinos de supino, remada, agachamento e elevação lateral
 * entre fevereiro e 20/10/2026, no fuso de Brasília. O "agora" dos testes é quarta-feira, 21/10/2026, ao meio-dia
 * (`PROGRESS_NOW`). Todas as contas dos testes são feitas à mão a partir desta tabela.
 *
 * Supino (1RM pela fórmula de Epley: carga × (1 + repetições / 30)):
 *   10/02  30 × 10 → 40,00     02/09  32,5 × 10 → 43,33     23/09  40   ×  8 → 50,67     14/10  42,5 × 8 e 40 × 10 → 53,83
 *   10/06  30 × 10 → 40,00     09/09  35   × 10 → 46,67     30/09  40   × 10 → 53,33     19/10  3 × (45 × 6)       → 54,00
 *                              16/09  37,5 × 10 → 50,00     07/10  42,5 ×  8 → 53,83
 *   Nas últimas 8 semanas (desde 26/08) são 8 dias; em 6 meses, 9; em "Tudo", 10.
 *
 * Outros treinos: remada 3 × (50 × 10) em 16/10; agachamento 4 × (60 × 8) em 20/10; elevação lateral 3 × (8 × 12) em 23/09
 * (as anotações dela testam as aspas, a vírgula e a fórmula `=2+2` do CSV).
 */
export const PROGRESS_NOW = Date.UTC(2026, 9, 21, 15, 0);

type SetSeed = readonly [kg: number, reps: number, note?: string];

interface SessionSeed {
  readonly day: string;
  readonly items: readonly (readonly [
    exercise: keyof typeof EXERCISES,
    sets: readonly SetSeed[],
  ])[];
}

const EXERCISES = {
  bench: SEED_EXERCISE_IDS.bench,
  row: SEED_EXERCISE_IDS.row,
  squat: SEED_EXERCISE_IDS.squat,
  lateral: '00000000-0000-4000-8000-000000000015',
  incline: SEED_EXERCISE_IDS.inclineDumbbell,
  dumbbell: '00000000-0000-4000-8000-000000000003',
  fly: '00000000-0000-4000-8000-000000000004',
  extension: '00000000-0000-4000-8000-000000000006',
} as const;

const SESSIONS: readonly SessionSeed[] = [
  { day: '2026-02-10', items: [['bench', [[30, 10]]]] },
  { day: '2026-06-10', items: [['bench', [[30, 10]]]] },
  { day: '2026-09-02', items: [['bench', [[32.5, 10]]]] },
  { day: '2026-09-09', items: [['bench', [[35, 10]]]] },
  { day: '2026-09-16', items: [['bench', [[37.5, 10]]]] },
  {
    day: '2026-09-23',
    items: [
      ['bench', [[40, 8]]],
      [
        'lateral',
        [
          [8, 12, '=2+2'],
          [8, 12, 'diz "oi", tudo bem'],
          [8, 12],
        ],
      ],
    ],
  },
  { day: '2026-09-30', items: [['bench', [[40, 10]]]] },
  { day: '2026-10-07', items: [['bench', [[42.5, 8]]]] },
  {
    day: '2026-10-14',
    items: [
      [
        'bench',
        [
          [42.5, 8],
          [40, 10],
        ],
      ],
    ],
  },
  {
    day: '2026-10-16',
    items: [
      [
        'row',
        [
          [50, 10],
          [50, 10],
          [50, 10],
        ],
      ],
    ],
  },
  {
    day: '2026-10-19',
    items: [
      [
        'bench',
        [
          [45, 6],
          [45, 6],
          [45, 6],
        ],
      ],
    ],
  },
  {
    day: '2026-10-20',
    items: [
      [
        'squat',
        [
          [60, 8],
          [60, 8],
          [60, 8],
          [60, 8],
        ],
      ],
    ],
  },
];

/** O instante de um dia às 12h de Brasília (15h UTC), mais `minutes` minutos. */
export function brasiliaNoon(day: string, minutes = 0): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date, 15, minutes);
}

const uuid = (block: number, n: number) =>
  `${block}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Linhas de treino e de série como a API as entrega, para `server.seed`. */
/**
 * Quatro exercícios a mais, um treino de uma série cada, para a lista passar de seis exercícios com histórico (a folha
 * "Outro exercício" só existe assim). Ficam antes de 02/09, longe das contas das semanas e dos recordes.
 */
const MORE_SESSIONS: readonly SessionSeed[] = [
  { day: '2026-08-31', items: [['incline', [[22.5, 10]]]] },
  { day: '2026-08-24', items: [['dumbbell', [[20, 10]]]] },
  { day: '2026-08-17', items: [['fly', [[12, 12]]]] },
  { day: '2026-08-10', items: [['extension', [[35, 12]]]] },
];

export function progressRows(options: { more?: boolean } = {}): { sessions: Row[]; sets: Row[] } {
  const sessions: Row[] = [];
  const sets: Row[] = [];
  let setNumber = 0;
  const all = options.more === true ? [...SESSIONS, ...MORE_SESSIONS] : SESSIONS;
  all.forEach((session, index) => {
    const id = uuid(3, index + 1);
    const startedAt = brasiliaNoon(session.day);
    sessions.push({
      id,
      routineId: null,
      startedAt: dotnetInstant(startedAt),
      finishedAt: dotnetInstant(startedAt + 3_000_000),
      note: null,
      feeling: null,
      deviceId: 'aparelho-de-teste',
    });
    let position = 0;
    for (const [exercise, exerciseSets] of session.items) {
      for (const [weightKg, reps, note] of exerciseSets) {
        setNumber++;
        sets.push({
          id: uuid(4, setNumber),
          sessionId: id,
          exerciseId: EXERCISES[exercise],
          position: position,
          setType: 'work',
          weightKg,
          reps,
          durationS: null,
          rir: null,
          rpe: null,
          note: note ?? null,
          completedAt: dotnetInstant(brasiliaNoon(session.day, 1 + position)),
        });
        position++;
      }
    }
  });
  return { sessions, sets };
}

/** Põe o histórico no servidor de teste (como se já estivesse na nuvem): a tela o puxa para o aparelho. */
export function seedProgress(server: TrainingServer, options: { more?: boolean } = {}): void {
  const { sessions, sets } = progressRows(options);
  server.seed('sessions', sessions);
  server.seed('sets', sets);
}

export const PROGRESS_EXERCISE_IDS = EXERCISES;
