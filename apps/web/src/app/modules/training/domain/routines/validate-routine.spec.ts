import { item, items, routine } from './routine-test-kit';
import { validateRoutine, type RoutineIssue } from './validate-routine';

const codes = (issues: readonly RoutineIssue[]) => issues.map((issue) => issue.code);

describe('validateRoutine', () => {
  it('accepts a valid routine, even an empty one', () => {
    expect(validateRoutine(routine())).toEqual([]);
    expect(validateRoutine(routine({ items: [] }))).toEqual([]);
  });

  describe('header', () => {
    it('refuses an empty name and one over 80 characters, after trimming', () => {
      expect(codes(validateRoutine(routine({ name: '   ' })))).toEqual(['name-length']);
      expect(codes(validateRoutine(routine({ name: '' })))).toEqual(['name-length']);
      expect(validateRoutine(routine({ name: 'a'.repeat(80) }))).toEqual([]);
      expect(validateRoutine(routine({ name: `  ${'a'.repeat(80)}  ` }))).toEqual([]);
      expect(codes(validateRoutine(routine({ name: 'a'.repeat(81) })))).toEqual(['name-length']);
    });

    it('refuses a position out of 0 to 1000 or not whole', () => {
      expect(validateRoutine(routine({ position: 0 }))).toEqual([]);
      expect(validateRoutine(routine({ position: 1000 }))).toEqual([]);
      expect(codes(validateRoutine(routine({ position: -1 })))).toEqual(['position-range']);
      expect(codes(validateRoutine(routine({ position: 1001 })))).toEqual(['position-range']);
      expect(codes(validateRoutine(routine({ position: 1.5 })))).toEqual(['position-range']);
    });

    it('refuses a note over 500 characters', () => {
      expect(validateRoutine(routine({ note: 'x'.repeat(500) }))).toEqual([]);
      expect(codes(validateRoutine(routine({ note: 'x'.repeat(501) })))).toEqual(['note-length']);
    });
  });

  describe('items', () => {
    it('accepts 40 and refuses 41', () => {
      const many = (count: number) =>
        Array.from({ length: count }, (_, index) => item(`i${index}`, index));

      expect(validateRoutine(routine({ items: many(40) }))).toEqual([]);
      expect(validateRoutine(routine({ items: many(41) }))).toEqual([
        { path: 'items', code: 'too-many-items' },
      ]);
    });

    it('refuses sets out of 1 to 20', () => {
      expect(validateRoutine(routine({ items: [item('a', 0, { targetSets: 1 })] }))).toEqual([]);
      expect(validateRoutine(routine({ items: [item('a', 0, { targetSets: 20 })] }))).toEqual([]);
      expect(validateRoutine(routine({ items: [item('a', 0, { targetSets: 0 })] }))).toEqual([
        { path: 'items[0].targetSets', code: 'item-sets-range' },
      ]);
      expect(
        codes(validateRoutine(routine({ items: [item('a', 0, { targetSets: 21 })] }))),
      ).toEqual(['item-sets-range']);
    });

    it('refuses a rep range out of 1 to 100 or with the minimum above the maximum', () => {
      const withReps = (repMin: number, repMax: number) =>
        codes(validateRoutine(routine({ items: [item('a', 0, { repMin, repMax })] })));

      expect(withReps(8, 12)).toEqual([]);
      expect(withReps(10, 10)).toEqual([]);
      expect(withReps(1, 100)).toEqual([]);
      expect(withReps(12, 8)).toEqual(['item-reps-range']);
      expect(withReps(0, 10)).toEqual(['item-reps-range']);
      expect(withReps(8, 101)).toEqual(['item-reps-range']);
    });

    it('refuses rest out of 0 to 1800 seconds', () => {
      const withRest = (restSeconds: number) =>
        codes(validateRoutine(routine({ items: [item('a', 0, { restSeconds })] })));

      expect(withRest(0)).toEqual([]);
      expect(withRest(1800)).toEqual([]);
      expect(withRest(-1)).toEqual(['item-rest-range']);
      expect(withRest(1801)).toEqual(['item-rest-range']);
    });

    it('refuses an item note over 300 characters', () => {
      expect(
        codes(validateRoutine(routine({ items: [item('a', 0, { note: 'x'.repeat(301) })] }))),
      ).toEqual(['item-note-length']);
    });

    it('refuses a missing or repeated id and a missing exercise', () => {
      expect(codes(validateRoutine(routine({ items: [item('', 0)] })))).toEqual([
        'item-id-missing',
      ]);
      expect(codes(validateRoutine(routine({ items: [item('a', 0), item('a', 1)] })))).toEqual([
        'item-id-duplicate',
      ]);
      expect(
        codes(validateRoutine(routine({ items: [item('a', 0, { exerciseId: '' })] }))),
      ).toEqual(['item-exercise-missing']);
    });

    it('refuses a superset group out of 1 to 100', () => {
      expect(codes(validateRoutine(routine({ items: items([0, 0]) })))).toEqual([
        'item-superset-range',
        'item-superset-range',
      ]);
      expect(codes(validateRoutine(routine({ items: items([101, 101]) })))).toEqual([
        'item-superset-range',
        'item-superset-range',
      ]);
    });

    it('points at the item that is wrong', () => {
      const issues = validateRoutine(
        routine({ items: [item('a', 0), item('b', 1, { targetSets: 99 })] }),
      );

      expect(issues).toEqual([{ path: 'items[1].targetSets', code: 'item-sets-range' }]);
    });

    it('reports every problem, not only the first', () => {
      const issues = validateRoutine(
        routine({ name: '', items: [item('a', 0, { targetSets: 0, restSeconds: -1 })] }),
      );

      expect(codes(issues)).toEqual(['name-length', 'item-sets-range', 'item-rest-range']);
    });
  });

  describe('supersets', () => {
    it('accepts neighbours with the same group', () => {
      expect(validateRoutine(routine({ items: items([null, 1, 1, null, 2, 2, 2]) }))).toEqual([]);
    });

    it('refuses the same group on items that are not neighbours', () => {
      expect(validateRoutine(routine({ items: items([1, null, 1]) }))).toEqual([
        { path: 'items', code: 'superset-not-contiguous' },
      ]);
      expect(codes(validateRoutine(routine({ items: items([1, 2, 1]) })))).toEqual([
        'superset-not-contiguous',
      ]);
    });

    it('judges the order by position, not by the array order', () => {
      const shuffled = items([null, 1, 1]);

      expect(validateRoutine(routine({ items: [shuffled[2], shuffled[0], shuffled[1]] }))).toEqual(
        [],
      );
    });

    it('does not complain about a group with a single item (it is normalized when saved)', () => {
      expect(validateRoutine(routine({ items: items([null, 3, null]) }))).toEqual([]);
    });
  });
});
