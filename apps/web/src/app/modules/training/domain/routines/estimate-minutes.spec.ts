import { estimateMinutes } from './estimate-minutes';
import { item } from './routine-test-kit';

describe('estimateMinutes', () => {
  describe('without history', () => {
    it('is sets x (45 s + rest) + 90 s per exercise', () => {
      // 4 x (45 + 120) + 90 = 750 s = 12,5 min -> 13
      const only = { items: [item('a', 0, { targetSets: 4, restSeconds: 120 })] };

      expect(estimateMinutes(only)).toBe(13);
      expect(estimateMinutes(only, [])).toBe(13);
      expect(estimateMinutes(only, null)).toBe(13);
      expect(estimateMinutes(only, undefined)).toBe(13);
    });

    it('adds the exercises up', () => {
      // (3 x (45 + 60) + 90) x 2 = 810 s = 13,5 min -> 14
      const two = { items: [item('a', 0, { restSeconds: 60 }), item('b', 1, { restSeconds: 60 })] };

      expect(estimateMinutes(two)).toBe(14);
    });

    it('counts the rest once per round of a superset, with the rest of the last item', () => {
      // work: 2 x (3 x 45 + 90) = 450 s; rest: 3 rounds x 60 s = 180 s -> 630 s = 10,5 min -> 11
      const pair = {
        items: [
          item('a', 0, { supersetGroup: 1, restSeconds: 120 }),
          item('b', 1, { supersetGroup: 1, restSeconds: 60 }),
        ],
      };
      // Sem juntar, cada item descansa depois de cada série: 450 s + 3 x 120 s + 3 x 60 s = 990 s = 16,5 min -> 17.
      const apart = {
        items: [item('a', 0, { restSeconds: 120 }), item('b', 1, { restSeconds: 60 })],
      };

      expect(estimateMinutes(pair)).toBe(11);
      expect(estimateMinutes(apart)).toBe(17);
    });

    it('uses the most sets of the group as the number of rounds', () => {
      // work: (2 x 45 + 90) + (4 x 45 + 90) = 450 s; rest: 4 rounds x 60 s = 240 s -> 690 s = 11,5 min -> 12
      const uneven = {
        items: [
          item('a', 0, { targetSets: 2, supersetGroup: 1 }),
          item('b', 1, { targetSets: 4, supersetGroup: 1, restSeconds: 60 }),
        ],
      };

      expect(estimateMinutes(uneven)).toBe(12);
    });

    it('does not mix two different supersets next to each other', () => {
      const trio = {
        items: [
          item('a', 0, { supersetGroup: 1, restSeconds: 70 }),
          item('b', 1, { supersetGroup: 1, restSeconds: 70 }),
          item('c', 2, { supersetGroup: 2, restSeconds: 70 }),
          item('d', 3, { supersetGroup: 2, restSeconds: 70 }),
        ],
      };
      const single = { items: [trio.items[0], trio.items[1]] };

      expect(estimateMinutes(trio)).toBe(2 * estimateMinutes(single));
    });

    it('is zero for a routine with no exercise', () => {
      expect(estimateMinutes({ items: [] })).toBe(0);
    });

    it('reads the items in position order', () => {
      const shuffled = {
        items: [
          item('b', 1, { supersetGroup: 1, restSeconds: 60 }),
          item('a', 0, { supersetGroup: 1, restSeconds: 10 }),
        ],
      };

      // Na ordem certa o último do par é o "b" (descanso 60 s).
      expect(estimateMinutes(shuffled)).toBe(11);
    });
  });

  describe('with history', () => {
    const routine = { items: [item('a', 0)] };

    it('is the median of the three most recent sessions, newest first', () => {
      expect(estimateMinutes(routine, [50, 60, 40])).toBe(50);
      expect(estimateMinutes(routine, [30, 90, 60, 10, 10])).toBe(60);
    });

    it('with fewer than three, is the median of the ones there are', () => {
      expect(estimateMinutes(routine, [45])).toBe(45);
      expect(estimateMinutes(routine, [40, 50])).toBe(45);
    });

    it('ignores what is not a positive number', () => {
      expect(estimateMinutes(routine, [Number.NaN, -3, 0, 52, Infinity])).toBe(52);
      expect(estimateMinutes(routine, [Number.NaN, 0])).toBe(estimateMinutes(routine));
    });

    it('rounds to whole minutes and never goes below one', () => {
      expect(estimateMinutes(routine, [45.4])).toBe(45);
      expect(estimateMinutes(routine, [0.2])).toBe(1);
    });

    it('beats the formula, even for a routine with no exercise', () => {
      expect(estimateMinutes({ items: [] }, [30])).toBe(30);
    });
  });
});
