import type { ProgressSet } from '../domain/progress/series';
import { type SessionSet, recordsBySet, sessionRecords } from './records-view';

const past = (weightKg: number, reps: number, at = 1): ProgressSet => ({
  sessionId: 'antes',
  setType: 'work',
  weightKg,
  reps,
  completedAt: at,
});

function today(id: string, position: number, weightKg: number, reps: number): SessionSet {
  return {
    id,
    exerciseId: 'supino',
    sessionId: 'hoje',
    setType: 'work',
    weightKg,
    reps,
    completedAt: 1000 + position,
    position,
  };
}

describe('records of the workout', () => {
  describe('per set', () => {
    it('flags the set that went past the heaviest load and the best 1RM estimate, with the old values', () => {
      const flags = recordsBySet(new Map([['supino', [past(40, 10)]]]), [today('s1', 0, 42.5, 8)]);

      expect(flags.get('s1')).toEqual({
        maxWeight: { previousKg: 40, weightKg: 42.5 },
        oneRepMax: { previousKg: expect.closeTo(53.33, 1), valueKg: expect.closeTo(53.83, 1) },
      });
    });

    it('says nothing when there is no earlier history: the first time is not a record', () => {
      const flags = recordsBySet(new Map(), [today('s1', 0, 100, 5)]);

      expect(flags.size).toBe(0);
    });

    it('does not flag a set that only ties the best', () => {
      const flags = recordsBySet(new Map([['supino', [past(40, 10)]]]), [today('s1', 0, 40, 10)]);

      expect(flags.size).toBe(0);
    });

    it('compares with the sets made earlier in the same workout: the second equal set is not a record again', () => {
      const flags = recordsBySet(new Map([['supino', [past(40, 10)]]]), [
        today('s1', 0, 42.5, 8),
        today('s2', 1, 42.5, 8),
      ]);

      expect([...flags.keys()]).toEqual(['s1']);
    });
  });

  describe('for the whole workout', () => {
    it('lists the max load and the 1RM estimate that the workout beat, each with what it was before', () => {
      const records = sessionRecords(new Map([['supino', [past(40, 10)]]]), [
        today('s1', 0, 40, 10),
        today('s2', 1, 42.5, 8),
      ]);

      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        exerciseId: 'supino',
        kind: 'maxWeight',
        previousKg: 40,
        valueKg: 42.5,
        reps: 8,
      });
      expect(records[1]).toMatchObject({ kind: 'oneRepMax', reps: 8 });
      expect(records[1].valueKg).toBeGreaterThan(records[1].previousKg);
    });

    it('has nothing for an exercise with no history before the workout', () => {
      expect(sessionRecords(new Map(), [today('s1', 0, 100, 5)])).toEqual([]);
    });

    it('has nothing when the workout did not go past the best of before', () => {
      expect(
        sessionRecords(new Map([['supino', [past(50, 10)]]]), [today('s1', 0, 40, 10)]),
      ).toEqual([]);
    });
  });
});
