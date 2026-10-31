import {
  adjustedWeeklyGoal,
  programWeeklyGoal,
  remainingWorkouts,
  weeklyStreak,
} from './training-rhythm';

const routine = (id: string, weekdays: number[] = [], programId = 'p1') => ({
  id,
  position: 0,
  active: true,
  deletedAt: null,
  programId,
  weekdays,
});

describe('training rhythm', () => {
  it('reports what is still missing and never goes below zero', () => {
    expect(remainingWorkouts(3, 1, 0)).toBe(2);
    expect(remainingWorkouts(3, 4, 0)).toBe(0);
  });

  it('lowers the weekly goal in proportion to the planned absence days', () => {
    expect(adjustedWeeklyGoal(3, 0)).toBe(3);
    expect(adjustedWeeklyGoal(3, 3)).toBe(2);
    expect(adjustedWeeklyGoal(5, 7)).toBe(0);
    expect(remainingWorkouts(3, 1, 3)).toBe(1);
    expect(remainingWorkouts(3, 0, 7)).toBe(0);
  });

  it('ignores an absence that falls only on rest days of the program', () => {
    // Programa de segunda a sexta (5 dias de treino): sábado e domingo ausentes não custam nada.
    expect(adjustedWeeklyGoal(5, 0, 5)).toBe(5);
    expect(remainingWorkouts(5, 1, 0, 5)).toBe(4);
    // Duas das três sessões do programa caem na ausência: sobra uma por fazer.
    expect(adjustedWeeklyGoal(3, 2, 3)).toBe(1);
    expect(adjustedWeeklyGoal(3, 3, 3)).toBe(0);
  });

  it('does not break the completed-week streak for a week of planned absence', () => {
    expect(
      weeklyStreak([
        { completed: 3, goal: 3, absentDays: 0 },
        { completed: 0, goal: 3, absentDays: 7 },
        { completed: 3, goal: 3, absentDays: 0 },
      ]),
    ).toBe(2);
  });

  it('counts a week met only after the absence adjustment, and a short week ends the streak', () => {
    expect(
      weeklyStreak([
        { completed: 2, goal: 3, absentDays: 3 },
        { completed: 2, goal: 3, absentDays: 0 },
        { completed: 3, goal: 3, absentDays: 0 },
      ]),
    ).toBe(1);
  });

  it('does not let a week still in progress break the streak', () => {
    expect(
      weeklyStreak([
        { completed: 1, goal: 3, absentDays: 0, open: true },
        { completed: 3, goal: 3, absentDays: 0 },
        { completed: 3, goal: 3, absentDays: 0 },
      ]),
    ).toBe(2);
  });

  it('takes the default goal from the days the active program trains', () => {
    const routines = [routine('a', [1, 3, 5]), routine('b', [3]), routine('other', [2, 4], 'p2')];
    expect(programWeeklyGoal(routines, 'p1')).toBe(3);
    // Sem dias declarados vale segunda a sexta.
    expect(programWeeklyGoal([routine('free')], 'p1')).toBe(5);
    expect(programWeeklyGoal(routines, null)).toBeNull();
    expect(programWeeklyGoal(routines, 'missing')).toBeNull();
  });
});
