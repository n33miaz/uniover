import type { Row, TrainingServer } from './training-server';

/**
 * Dados-semente do Treino para os testes: poucos exercícios (alguns com ilustração, outros sem, um do wger) e duas
 * rotinas. Os ids são fixos para o teste poder abrir a ficha pelo endereço.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface ExerciseSeed {
  readonly n: number;
  readonly slug: string;
  readonly name: string;
  readonly primary: string;
  readonly secondary?: readonly string[];
  readonly equipment: string;
  readonly recordType?: string;
  readonly instructions?: readonly string[];
  readonly source?: string;
  readonly license?: { readonly name: string; readonly author: string; readonly url: string };
}

const CATALOG: readonly ExerciseSeed[] = [
  {
    n: 1,
    slug: 'supino-reto-com-barra',
    name: 'Supino reto com barra',
    primary: 'chest',
    secondary: ['triceps', 'shoulders'],
    equipment: 'barbell',
    instructions: [
      'Deite no banco com os pés firmes no chão e os olhos sob a barra.',
      'Segure a barra um pouco mais aberta que os ombros e tire-a do suporte.',
      'Desça a barra até tocar de leve o meio do peito, controlando o movimento.',
      'Empurre a barra para cima até estender os cotovelos, sem tirar as costas do banco.',
      'Termine a série devolvendo a barra ao suporte com cuidado.',
    ],
  },
  {
    n: 2,
    slug: 'supino-inclinado-com-halteres',
    name: 'Supino inclinado com halteres',
    primary: 'chest',
    secondary: ['shoulders', 'triceps'],
    equipment: 'dumbbell',
    instructions: ['Ajuste o banco inclinado.', 'Empurre os halteres para cima.', 'Desça devagar.'],
  },
  {
    n: 3,
    slug: 'supino-reto-com-halteres',
    name: 'Supino reto com halteres',
    primary: 'chest',
    secondary: ['triceps'],
    equipment: 'dumbbell',
    instructions: ['Deite no banco reto.', 'Empurre os halteres para cima.'],
  },
  {
    n: 4,
    slug: 'crucifixo-reto-com-halteres',
    name: 'Crucifixo reto com halteres',
    primary: 'chest',
    equipment: 'dumbbell',
    instructions: ['Abra os braços em arco.', 'Junte os halteres sobre o peito.'],
  },
  {
    n: 5,
    slug: 'agachamento-livre-com-barra',
    name: 'Agachamento livre com barra',
    primary: 'quadriceps',
    secondary: ['glutes', 'hamstrings'],
    equipment: 'barbell',
    instructions: [
      'Apoie a barra nas costas.',
      'Desça até as coxas ficarem paralelas ao chão.',
      'Suba.',
    ],
  },
  {
    n: 6,
    slug: 'cadeira-extensora',
    name: 'Cadeira extensora',
    primary: 'quadriceps',
    equipment: 'machine',
    instructions: ['Ajuste o encosto.', 'Estenda os joelhos.'],
  },
  {
    n: 7,
    slug: 'remada-sentada-na-polia',
    name: 'Remada sentada na polia',
    primary: 'middle_back',
    secondary: ['biceps', 'lats'],
    equipment: 'cable',
    instructions: ['Sente com o peito aberto.', 'Puxe o triângulo até o abdômen.'],
  },
  {
    n: 8,
    slug: 'puxada-supinada-na-polia',
    name: 'Puxada supinada na polia',
    primary: 'lats',
    secondary: ['biceps'],
    equipment: 'cable',
    instructions: ['Segure a barra com as palmas para você.', 'Puxe até o queixo.'],
  },
  {
    n: 9,
    slug: 'rosca-direta-com-barra',
    name: 'Rosca direta com barra',
    primary: 'biceps',
    secondary: ['forearms'],
    equipment: 'barbell',
    instructions: ['Em pé, segure a barra com as palmas para cima.', 'Dobre os cotovelos.'],
  },
  {
    n: 10,
    slug: 'desenvolvimento-militar-sentado-com-barra',
    name: 'Desenvolvimento militar sentado com barra',
    primary: 'shoulders',
    secondary: ['triceps'],
    equipment: 'barbell',
    instructions: ['Sente com as costas apoiadas.', 'Empurre a barra para cima.'],
  },
  {
    n: 11,
    slug: 'triceps-na-polia-com-corda',
    name: 'Tríceps na polia com corda',
    primary: 'triceps',
    equipment: 'cable',
    instructions: ['Cotovelos junto ao corpo.', 'Estenda os braços para baixo.'],
  },
  {
    n: 12,
    slug: 'prancha-isometrica',
    name: 'Prancha isométrica',
    primary: 'abdominals',
    equipment: 'bodyweight',
    recordType: 'time',
    instructions: ['Apoie antebraços e pontas dos pés.', 'Mantenha o corpo reto.'],
  },
  {
    n: 13,
    slug: 'abdominal-crunch',
    name: 'Abdominal crunch',
    primary: 'abdominals',
    equipment: 'bodyweight',
    recordType: 'reps_only',
    instructions: ['Deite com os joelhos dobrados.', 'Suba o tronco contraindo o abdômen.'],
  },
  {
    n: 14,
    slug: 'flexao-de-braco',
    name: 'Flexão de braço',
    primary: 'chest',
    secondary: ['triceps'],
    equipment: 'bodyweight',
    recordType: 'reps_only',
    instructions: ['Mãos no chão, corpo reto.', 'Desça o peito e suba.'],
  },
  {
    n: 15,
    slug: 'elevacao-lateral-com-halteres',
    name: 'Elevação lateral com halteres',
    primary: 'shoulders',
    equipment: 'dumbbell',
    instructions: ['Eleve os braços até a altura dos ombros.'],
  },
  {
    n: 16,
    slug: 'remada-unilateral-com-halter-wger',
    name: 'Remada unilateral com halter',
    primary: 'lats',
    secondary: ['biceps'],
    equipment: 'dumbbell',
    source: 'wger',
    license: {
      name: 'CC-BY-SA 4',
      author: 'Maria Souza',
      url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    instructions: ['Apoie um joelho no banco.', 'Puxe o halter até a cintura.'],
  },
];

export const SEED_EXERCISE_IDS = {
  bench: id(1),
  inclineDumbbell: id(2),
  squat: id(5),
  row: id(7),
  curl: id(9),
  pushdown: id(11),
  plank: id(12),
  pushUp: id(14),
  wger: id(16),
} as const;

export function seedExercise(seed: ExerciseSeed): Row {
  const at = '2026-10-01T10:00:00.0000000+00:00';
  return {
    id: id(seed.n),
    slug: seed.slug,
    source: seed.source ?? 'free_exercise_db',
    sourceRef: `ref-${seed.n}`,
    name: seed.name,
    instructions: [...(seed.instructions ?? [])],
    primaryMuscles: [seed.primary],
    secondaryMuscles: [...(seed.secondary ?? [])],
    equipment: seed.equipment,
    recordType: seed.recordType ?? 'weight_reps',
    stepKg: null,
    stepClientUpdatedAt: null,
    level: null,
    category: null,
    mechanic: null,
    license: seed.license?.name ?? null,
    licenseAuthor: seed.license?.author ?? null,
    licenseUrl: seed.license?.url ?? null,
    reviewed: true,
    updatedAt: at,
    clientUpdatedAt: at,
    deleted: false,
  };
}

function routine(
  n: number,
  name: string,
  position: number,
  items: readonly [exercise: number, sets: number, repMin: number, repMax: number, rest: number][],
): Row {
  const at = '2026-10-02T10:00:00.0000000+00:00';
  return {
    id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name,
    position,
    active: true,
    programId: null,
    weekdays: [],
    note: null,
    items: items.map(([exercise, sets, repMin, repMax, rest], index) => ({
      id: `20000000-0000-4000-8000-${String(n * 10 + index).padStart(12, '0')}`,
      exerciseId: id(exercise),
      position: index,
      targetSets: sets,
      repMin,
      repMax,
      restSeconds: rest,
      supersetGroup: null,
      note: null,
    })),
    updatedAt: at,
    clientUpdatedAt: at,
    deleted: false,
  };
}

export const SEED_ROUTINE_IDS = {
  a: '10000000-0000-4000-8000-000000000001',
  b: '10000000-0000-4000-8000-000000000002',
} as const;

/** Os modelos prontos do servidor (ABC, ABCD, full body), com um exercício que o catálogo de teste não tem. */
export const SEED_TEMPLATES = {
  items: [
    {
      id: 'abc',
      name: 'ABC',
      description: 'Três treinos: peito e tríceps, costas e bíceps, pernas e ombros.',
      routines: [
        {
          name: 'A · Peito e tríceps',
          items: [
            ['supino-reto-com-barra', 4, 6, 10, 120],
            ['supino-inclinado-com-halteres', 3, 8, 12, 90],
            ['triceps-na-polia-com-corda', 3, 10, 15, 60],
          ],
        },
        {
          name: 'B · Costas e bíceps',
          items: [
            ['puxada-supinada-na-polia', 4, 8, 12, 90],
            ['remada-sentada-na-polia', 3, 8, 12, 90],
            ['rosca-direta-com-barra', 3, 8, 12, 60],
          ],
        },
        {
          name: 'C · Pernas e ombros',
          items: [
            ['agachamento-livre-com-barra', 4, 6, 10, 120],
            ['cadeira-extensora', 3, 10, 15, 60],
            ['leg-press-que-o-catalogo-de-teste-nao-tem', 3, 10, 15, 90],
          ],
        },
      ].map((day) => ({
        name: day.name,
        items: day.items.map(([exerciseSlug, targetSets, repMin, repMax, restSeconds]) => ({
          exerciseSlug,
          targetSets,
          repMin,
          repMax,
          restSeconds,
          supersetGroup: null,
        })),
      })),
    },
    {
      id: 'full-body',
      name: 'Full body',
      description: 'Um treino que passa pelo corpo todo, para fazer dois ou três dias por semana.',
      routines: [
        {
          name: 'Corpo todo',
          items: [
            {
              exerciseSlug: 'agachamento-livre-com-barra',
              targetSets: 3,
              repMin: 8,
              repMax: 12,
              restSeconds: 90,
              supersetGroup: null,
            },
            {
              exerciseSlug: 'supino-reto-com-barra',
              targetSets: 3,
              repMin: 8,
              repMax: 12,
              restSeconds: 90,
              supersetGroup: null,
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Põe o catálogo e as rotinas de teste no servidor. `extra` acrescenta exercícios de enchimento (para a lista passar de
 * uma página); `routines: false` deixa o servidor sem nenhuma rotina.
 */
export function seedTraining(
  server: TrainingServer,
  options: { extra?: number; routines?: boolean; catalog?: boolean } = {},
): void {
  if (options.catalog !== false) {
    server.seed('exercises', CATALOG.map(seedExercise));
    const filler: Row[] = [];
    for (let index = 1; index <= (options.extra ?? 0); index++) {
      filler.push(
        seedExercise({
          n: 100 + index,
          slug: `enchimento-${index}`,
          name: `Exercício de enchimento ${String(index).padStart(2, '0')}`,
          primary: 'calves',
          equipment: 'machine',
          instructions: ['Faça o movimento.'],
        }),
      );
    }
    if (filler.length > 0) server.seed('exercises', filler);
  }
  if (options.routines !== false) {
    server.seed('routines', [
      routine(1, 'Treino A · Peito e tríceps', 0, [
        [1, 4, 6, 10, 120],
        [2, 3, 8, 12, 90],
        [11, 3, 10, 15, 60],
      ]),
      routine(2, 'Treino B · Costas e bíceps', 1, [
        [8, 4, 8, 12, 90],
        [7, 3, 8, 12, 90],
        [9, 3, 8, 12, 60],
      ]),
    ]);
  }
  server.templates = SEED_TEMPLATES;
}
