import type { LocalRoutine } from '../data/routines/routine';
import type { LocalSession } from '../data/sessions/session';
import { item } from '../shell/screen-test-kit';
import { buildRoutineEntries } from './routine-stats';

const AT = 1_760_000_000_000;
const MIN = 60_000;

function routine(
  id: string,
  position: number,
  overrides: Partial<LocalRoutine> = {},
): LocalRoutine {
  return {
    id,
    name: `Treino ${id}`,
    position,
    active: true,
    note: '',
    items: [item(`${id}1`, 'x', 0), item(`${id}2`, 'y', 1)],
    updatedAt: AT,
    clientUpdatedAt: AT,
    deletedAt: null,
    ...overrides,
  };
}

function session(routineId: string, startedMin: number, lengthMin: number | null): LocalSession {
  const startedAt = AT + startedMin * MIN;
  return {
    id: `${routineId}-${startedMin}`,
    routineId,
    startedAt,
    finishedAt: lengthMin === null ? null : startedAt + lengthMin * MIN,
    note: '',
    feeling: null,
    deviceId: 'd',
    updatedAt: startedAt,
    clientUpdatedAt: startedAt,
    deletedAt: null,
  };
}

describe('buildRoutineEntries', () => {
  const a = routine('a', 0);
  const b = routine('b', 1);
  const c = routine('c', 2);

  it('letters the routines in the order of the sequence and counts exercises and sets', () => {
    const entries = buildRoutineEntries([a, b], [a, b], []);
    expect(entries.map((entry) => entry.letter)).toEqual(['A', 'B']);
    expect(entries[0]).toMatchObject({ exercises: 2, sets: 6 });
  });

  it('suggests the first routine as the next one while there is no history', () => {
    const entries = buildRoutineEntries([a, b, c], [a, b, c], []);
    expect(entries.map((entry) => entry.next)).toEqual([true, false, false]);
  });

  it('suggests the routine after the last one that was finished', () => {
    const sessions = [session('a', 0, 50), session('b', 1000, 45)];
    const entries = buildRoutineEntries([a, b, c], [a, b, c], sessions);
    expect(entries.map((entry) => entry.next)).toEqual([false, false, true]);
  });

  it('ignores a workout that is still open when it looks for the last one finished', () => {
    const sessions = [session('a', 0, 50), session('b', 500, null)];
    const entries = buildRoutineEntries([a, b], [a, b], sessions);
    expect(entries.map((entry) => entry.next)).toEqual([false, true]);
  });

  it('estimates the duration from the last workouts of the routine, or by the sum when there is none', () => {
    const sessions = [session('a', 0, 40), session('a', 100, 50), session('a', 200, 60)];
    const [withHistory, without] = buildRoutineEntries([a, b], [a, b], sessions);
    expect(withHistory.minutes).toBe(50);
    expect(without.minutes).toBeGreaterThan(0);
    expect(without.minutes).not.toBe(50);
  });

  it('has no duration for a routine without exercises, and does not suggest an inactive one', () => {
    const empty = routine('e', 0, { items: [] });
    const off = routine('f', 1, { active: false });
    const entries = buildRoutineEntries([empty, off], [empty, off], []);
    expect(entries[0].minutes).toBeNull();
    expect(entries.map((entry) => entry.next)).toEqual([true, false]);
  });
});
