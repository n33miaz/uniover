import { isoWeekday, planForDay, type PlanRoutine, type PlanSession } from './week-plan';

// 2026-10-26 é segunda; meio-dia no relógio local do teste.
const at = (day: number, hour = 12): number => new Date(2026, 9, 26 + day, hour).getTime();
const MONDAY = at(0);
const TUESDAY = at(1);
const SATURDAY = at(5);
const SUNDAY = at(6);

const routine = (
  id: string,
  position: number,
  programId: string | null,
  weekdays: number[],
  extra: Partial<PlanRoutine> = {},
): PlanRoutine => ({
  id,
  position,
  active: true,
  deletedAt: null,
  programId,
  weekdays,
  ...extra,
});

/** Treino terminado; por padrão começou uma hora antes de terminar. */
const done = (
  routineId: string,
  finishedAt: number,
  startedAt = finishedAt - 3_600_000,
): PlanSession => ({
  routineId,
  startedAt,
  finishedAt,
  deletedAt: null,
});

const SPLIT = [
  routine('seg', 0, 'split', [1]),
  routine('ter', 1, 'split', [2]),
  routine('qua', 2, 'split', [3]),
  routine('qui', 3, 'split', [4]),
  routine('sex', 4, 'split', [5]),
];
const FULL_BODY = [
  routine('a', 0, 'fb', [1]),
  routine('b', 1, 'fb', [3]),
  routine('c', 2, 'fb', [5]),
];
const AB = [routine('A', 0, 'ab', [1, 2, 3, 4, 5]), routine('B', 1, 'ab', [1, 2, 3, 4, 5])];

describe('isoWeekday', () => {
  it('counts Monday as 1 and Sunday as 7', () => {
    expect(isoWeekday(MONDAY)).toBe(1);
    expect(isoWeekday(SATURDAY)).toBe(6);
    expect(isoWeekday(SUNDAY)).toBe(7);
  });
});

describe('planForDay', () => {
  it('does nothing without a chosen program (free routines keep the sequence)', () => {
    expect(planForDay([routine('x', 0, null, [])], [], MONDAY, null)).toEqual({
      routineId: null,
      resting: false,
    });
    expect(planForDay([], [], MONDAY, null)).toEqual({ routineId: null, resting: false });
  });

  it('does nothing while the chosen program has no routine on this device yet', () => {
    expect(planForDay(SPLIT, [], MONDAY, 'outro')).toEqual({ routineId: null, resting: false });
  });

  it('shows Monday on Monday and Tuesday on Tuesday, whatever the history', () => {
    expect(planForDay(SPLIT, [], MONDAY, 'split').routineId).toBe('seg');
    expect(planForDay(SPLIT, [done('seg', MONDAY)], TUESDAY, 'split').routineId).toBe('ter');
    expect(planForDay(SPLIT, [done('qui', at(-4))], TUESDAY, 'split').routineId).toBe('ter');
  });

  it('keeps showing the day routine after finishing it (no jump ahead)', () => {
    expect(planForDay(SPLIT, [done('seg', MONDAY + 1000)], MONDAY + 2000, 'split')).toEqual({
      routineId: 'seg',
      resting: false,
    });
  });

  it('rests on the weekend of a weekday split', () => {
    expect(planForDay(SPLIT, [], SATURDAY, 'split')).toEqual({ routineId: null, resting: true });
    expect(planForDay(SPLIT, [], SUNDAY, 'split')).toEqual({ routineId: null, resting: true });
  });

  it('full body trains on Monday, Wednesday and Friday and rests on Tuesday and Thursday', () => {
    const plan = (time: number) => planForDay(FULL_BODY, [], time, 'fb');
    expect(plan(MONDAY).routineId).toBe('a');
    expect(plan(TUESDAY)).toEqual({ routineId: null, resting: true });
    expect(plan(at(2)).routineId).toBe('b');
    expect(plan(at(3)).resting).toBe(true);
    expect(plan(at(4)).routineId).toBe('c');
    expect(plan(SATURDAY).resting).toBe(true);
  });

  it('alternates A and B on training days and rests on the weekend', () => {
    const plan = (sessions: PlanSession[], time: number) => planForDay(AB, sessions, time, 'ab');
    expect(plan([], MONDAY).routineId).toBe('A');
    expect(plan([done('A', MONDAY)], TUESDAY).routineId).toBe('B');
    expect(plan([done('A', MONDAY), done('B', TUESDAY)], at(2)).routineId).toBe('A');
    // Sexta B, a semana seguinte começa com A (sequência contínua).
    expect(plan([done('A', at(2)), done('B', at(4))], at(7)).routineId).toBe('A');
    expect(plan([], SATURDAY).resting).toBe(true);
  });

  it('stays on the routine already done today until midnight', () => {
    expect(planForDay(AB, [done('A', MONDAY - 1000)], MONDAY, 'ab').routineId).toBe('A');
    expect(planForDay(AB, [done('A', MONDAY - 1000)], TUESDAY, 'ab').routineId).toBe('B');
  });

  it('counts a workout on the day it STARTED: 23:50 to 00:10 belongs to the first day', () => {
    const overnight = done('A', at(1, 0) + 10 * 60_000, at(0, 23) + 50 * 60_000);
    // Terça às 8h: o treino da segunda à noite não conta como "feito hoje", então vem a próxima (B).
    expect(planForDay(AB, [overnight], at(1, 8), 'ab').routineId).toBe('B');
    // Segunda às 23h55 (ainda em andamento no relógio da segunda): conta como segunda.
    expect(planForDay(AB, [overnight], at(0, 23) + 55 * 60_000, 'ab').routineId).toBe('A');
  });

  it('a program routine without weekdays trains Monday to Friday and rests on the weekend', () => {
    const open = [routine('a', 0, 'abc', []), routine('b', 1, 'abc', [])];
    expect(planForDay(open, [], MONDAY, 'abc').routineId).toBe('a');
    expect(planForDay(open, [done('a', MONDAY)], TUESDAY, 'abc').routineId).toBe('b');
    expect(planForDay(open, [], SATURDAY, 'abc')).toEqual({ routineId: null, resting: true });
  });

  it('follows the chosen program, ignoring the other active ones and the inactive routines', () => {
    const old = SPLIT.map((r) => ({ ...r, active: false }));
    expect(planForDay([...old, ...FULL_BODY], [], TUESDAY, 'fb')).toEqual({
      routineId: null,
      resting: true,
    });
    expect(planForDay([...SPLIT, ...FULL_BODY], [], TUESDAY, 'fb').resting).toBe(true);
    expect(planForDay([...SPLIT, ...FULL_BODY], [], TUESDAY, 'split').routineId).toBe('ter');
  });

  it('ignores deleted routines and free routines', () => {
    const deleted = routine('apagada', 0, 'split', [1], { deletedAt: 5 });
    expect(
      planForDay([deleted, routine('livre', 1, null, [1])], [], MONDAY, 'split').routineId,
    ).toBeNull();
  });
});
