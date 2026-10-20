import { SAO_PAULO, at } from './progress-test-kit';
import { weekRange } from './calendar';
import {
  type WeekExercise,
  type WeekSet,
  trainedDays,
  weeklyConstancy,
  weeklySetsByGroup,
} from './week-stats';

const exercises = new Map<string, WeekExercise>([
  ['supino', { primaryMuscles: ['chest', 'triceps'] }],
  ['remada', { primaryMuscles: ['lats'] }],
  ['agacha', { primaryMuscles: ['quadriceps', 'glutes'] }],
  ['militar', { primaryMuscles: ['shoulders'] }],
  ['triceps', { primaryMuscles: ['triceps'] }],
  ['rosca', { primaryMuscles: ['biceps'] }],
  ['desconhecido', { primaryMuscles: ['muscle-of-the-future'] }],
  ['sem-musculo', { primaryMuscles: [] }],
]);

function sets(
  exerciseId: string,
  count: number,
  day: string,
  hour = 9,
  setType = 'work',
): WeekSet[] {
  return Array.from({ length: count }, (_, index) => ({
    exerciseId,
    setType,
    completedAt: at(day, hour, index),
  }));
}

/** A semana de referência, de 12 a 18 de outubro: treino A (16 séries), B (18) e C (20), 54 ao todo. */
function referenceWeek(): WeekSet[] {
  return [
    // Treino A (seg 12): peito 10 + tríceps 6, mais 2 de aquecimento que não contam.
    ...sets('supino', 10, '2026-10-12', 9),
    ...sets('triceps', 6, '2026-10-12', 10),
    ...sets('supino', 2, '2026-10-12', 8, 'warmup'),
    // Treino B (qua 14): costas 12 + bíceps 6.
    ...sets('remada', 12, '2026-10-14', 9),
    ...sets('rosca', 6, '2026-10-14', 10),
    ...sets('remada', 1, '2026-10-14', 8, 'warmup'),
    // Treino C (sex 16): pernas 12 + ombros 8.
    ...sets('agacha', 12, '2026-10-16', 9),
    ...sets('militar', 8, '2026-10-16', 10),
    ...sets('agacha', 3, '2026-10-16', 8, 'warmup'),
  ];
}

describe('weeklySetsByGroup', () => {
  const week = weekRange(at('2026-10-14'), SAO_PAULO);

  it('closes the reference week: 54 sets of 16 + 18 + 20, split by group (aquecimento does not count)', () => {
    const volume = weeklySetsByGroup(referenceWeek(), exercises, week.start, SAO_PAULO);

    expect(volume.total).toBe(54);
    expect(volume.byGroup).toEqual({
      chest: 10,
      back: 12,
      legs: 12,
      shoulders: 8,
      arms: 12,
      core: 0,
    });
    expect(volume.unclassified).toBe(0);
  });

  it('also gives the split by main muscle, which separates the triceps 6 and biceps 6 of the reference week', () => {
    const volume = weeklySetsByGroup(referenceWeek(), exercises, week.start, SAO_PAULO);

    expect(volume.byMuscle).toEqual({
      chest: 10,
      triceps: 6,
      lats: 12,
      biceps: 6,
      quadriceps: 12,
      shoulders: 8,
    });
    expect(Object.values(volume.byMuscle).reduce((sum, count) => sum + count, 0)).toBe(54);
  });

  it('counts each of the three workouts as in the reference week: 16, 18 and 20 sets', () => {
    const all = referenceWeek();
    const perDay = (day: string) =>
      weeklySetsByGroup(
        all.filter((set) => set.completedAt >= at(day, 0) && set.completedAt < at(day, 23, 59)),
        exercises,
        week.start,
        SAO_PAULO,
      ).total;

    expect([perDay('2026-10-12'), perDay('2026-10-14'), perDay('2026-10-16')]).toEqual([
      16, 18, 20,
    ]);
  });

  it('counts only the first main muscle of an exercise', () => {
    const volume = weeklySetsByGroup(
      sets('supino', 3, '2026-10-12'),
      exercises,
      week.start,
      SAO_PAULO,
    );

    expect(volume.byGroup.chest).toBe(3);
    expect(volume.byGroup.arms).toBe(0);
    expect(volume.byMuscle).toEqual({ chest: 3 });
  });

  it('takes Sunday 23:59 and leaves out Monday 00:00 of the next week and the week before', () => {
    const edges: WeekSet[] = [
      { exerciseId: 'supino', setType: 'work', completedAt: at('2026-10-12', 0, 0) },
      { exerciseId: 'supino', setType: 'work', completedAt: at('2026-10-18', 23, 59) },
      { exerciseId: 'supino', setType: 'work', completedAt: at('2026-10-19', 0, 0) },
      { exerciseId: 'supino', setType: 'work', completedAt: at('2026-10-11', 23, 59) },
    ];

    expect(weeklySetsByGroup(edges, exercises, week.start, SAO_PAULO).total).toBe(2);
  });

  it('puts sets of unknown exercises and unknown muscles in the total but in no group', () => {
    const odd = [
      ...sets('desconhecido', 2, '2026-10-12'),
      ...sets('sem-musculo', 1, '2026-10-12'),
      ...sets('nao-existe', 1, '2026-10-12'),
      ...sets('supino', 1, '2026-10-12'),
    ];

    const volume = weeklySetsByGroup(odd, exercises, week.start, SAO_PAULO);

    expect(volume.total).toBe(5);
    expect(volume.unclassified).toBe(4);
    expect(volume.byGroup.chest).toBe(1);
  });

  it('counts drop and failure sets as work, like the rest of the app', () => {
    const volume = weeklySetsByGroup(
      [
        ...sets('supino', 1, '2026-10-12', 9, 'failure'),
        ...sets('supino', 1, '2026-10-12', 10, 'drop'),
      ],
      exercises,
      week.start,
      SAO_PAULO,
    );

    expect(volume.total).toBe(2);
  });

  it('reads the week from any instant inside it', () => {
    const fromSunday = weekRange(at('2026-10-18', 20), SAO_PAULO);

    expect(weeklySetsByGroup(referenceWeek(), exercises, fromSunday.start, SAO_PAULO).total).toBe(
      54,
    );
    expect(
      weeklySetsByGroup(referenceWeek(), exercises, at('2026-10-15', 15), SAO_PAULO).total,
    ).toBe(54);
  });

  it('is empty for a week without sets', () => {
    const volume = weeklySetsByGroup([], exercises, week.start, SAO_PAULO);

    expect(volume.total).toBe(0);
    expect(volume.byMuscle).toEqual({});
  });

  it('measures a week that crosses the month: 31 August to 6 September', () => {
    const crossing = weekRange(at('2026-09-02'), SAO_PAULO);
    const both = [
      ...sets('supino', 2, '2026-08-31'),
      ...sets('supino', 3, '2026-09-04'),
      ...sets('supino', 1, '2026-09-07'),
    ];

    expect(weeklySetsByGroup(both, exercises, crossing.start, SAO_PAULO).total).toBe(5);
  });

  it('measures a week that crosses the year: 28 December to 3 January', () => {
    const crossing = weekRange(at('2027-01-01'), SAO_PAULO);
    const both = [
      ...sets('supino', 2, '2026-12-30'),
      ...sets('supino', 3, '2027-01-02'),
      ...sets('supino', 1, '2027-01-04'),
    ];

    expect(weeklySetsByGroup(both, exercises, crossing.start, SAO_PAULO).total).toBe(5);
  });
});

describe('trainedDays', () => {
  const october = { year: 2026, month: 10 };

  it('lists the days of the month with a workout, once each, in order', () => {
    const sessions = [
      { startedAt: at('2026-10-15', 18) },
      { startedAt: at('2026-10-01', 7) },
      { startedAt: at('2026-10-10', 7) },
      { startedAt: at('2026-10-10', 19) },
    ];

    expect(trainedDays(sessions, october, SAO_PAULO)).toEqual([1, 10, 15]);
  });

  it('respects the local midnight at both ends of the month', () => {
    const sessions = [
      { startedAt: at('2026-09-30', 23, 59) },
      { startedAt: at('2026-10-01', 0, 0) },
      { startedAt: at('2026-10-31', 23, 59) },
      { startedAt: at('2026-11-01', 0, 0) },
    ];

    expect(trainedDays(sessions, october, SAO_PAULO)).toEqual([1, 31]);
  });

  it('is empty for a month without workouts', () => {
    expect(trainedDays([{ startedAt: at('2026-09-10') }], october, SAO_PAULO)).toEqual([]);
  });

  it('handles December (the month after is January of the next year)', () => {
    expect(
      trainedDays(
        [{ startedAt: at('2026-12-31', 22) }, { startedAt: at('2027-01-01', 1) }],
        { year: 2026, month: 12 },
        SAO_PAULO,
      ),
    ).toEqual([31]);
  });
});

describe('weeklyConstancy', () => {
  const now = at('2026-10-18', 20);

  const sessions = (days: string[]) => days.map((day) => ({ startedAt: at(day, 8) }));

  it('shows 3 workouts a week in the last two weeks against a goal of 3', () => {
    const result = weeklyConstancy(
      sessions([
        '2026-10-05',
        '2026-10-07',
        '2026-10-09',
        '2026-10-12',
        '2026-10-14',
        '2026-10-16',
      ]),
      3,
      SAO_PAULO,
      now,
    );

    expect(result.weeks).toHaveLength(8);
    expect(result.weeks.at(-1)).toMatchObject({ startKey: '2026-10-12', sessions: 3, met: true });
    expect(result.weeks.at(-2)).toMatchObject({ startKey: '2026-10-05', sessions: 3, met: true });
    expect(result.consecutiveMetWeeks).toBe(2);
  });

  it('does not break the streak for a current week that is not finished yet', () => {
    const result = weeklyConstancy(
      sessions(['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12']),
      3,
      SAO_PAULO,
      now,
    );

    expect(result.weeks.at(-1)).toMatchObject({ sessions: 1, met: false });
    expect(result.consecutiveMetWeeks).toBe(1);
  });

  it('breaks the streak at a finished week below the goal', () => {
    const result = weeklyConstancy(
      sessions([
        '2026-09-28',
        '2026-10-05',
        '2026-10-07',
        '2026-10-09',
        '2026-10-12',
        '2026-10-14',
        '2026-10-16',
      ]),
      3,
      SAO_PAULO,
      now,
    );

    expect(result.weeks.at(-3)).toMatchObject({ startKey: '2026-09-28', sessions: 1, met: false });
    expect(result.consecutiveMetWeeks).toBe(2);
  });

  it('counts the weeks by the local Monday, the earliest first', () => {
    const result = weeklyConstancy([], 3, SAO_PAULO, now, 3);

    expect(result.weeks.map((week) => week.startKey)).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ]);
    expect(result.consecutiveMetWeeks).toBe(0);
  });

  it('puts a Sunday-night workout in its own week and a Monday-midnight one in the next', () => {
    const result = weeklyConstancy(
      [{ startedAt: at('2026-10-18', 23, 59) }, { startedAt: at('2026-10-19', 0, 0) }],
      1,
      SAO_PAULO,
      at('2026-10-19', 12),
      2,
    );

    expect(result.weeks.map((week) => [week.startKey, week.sessions])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-19', 1],
    ]);
  });

  it('crosses the year without losing a week', () => {
    const result = weeklyConstancy([], 3, SAO_PAULO, at('2027-01-05'), 3);

    expect(result.weeks.map((week) => week.startKey)).toEqual([
      '2026-12-21',
      '2026-12-28',
      '2027-01-04',
    ]);
  });
});
