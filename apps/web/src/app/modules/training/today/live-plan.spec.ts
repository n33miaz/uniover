import type { RoutineItemModel } from '../domain/routines/routine-model';
import { buildLivePlan, extraKey, itemKey } from './live-plan';

function item(
  id: string,
  exerciseId: string,
  position: number,
  overrides: Partial<RoutineItemModel> = {},
): RoutineItemModel {
  return {
    id,
    exerciseId,
    position,
    targetSets: 3,
    repMin: 8,
    repMax: 12,
    restSeconds: 90,
    supersetGroup: null,
    note: '',
    ...overrides,
  };
}

const work = (exerciseId: string) => ({ exerciseId, setType: 'work' });
const warmup = (exerciseId: string) => ({ exerciseId, setType: 'warmup' });

const base = {
  items: [item('i1', 'supino', 0), item('i2', 'remada', 1), item('i3', 'rosca', 2)],
  sets: [] as { exerciseId: string; setType: string }[],
  skipped: [] as string[],
  swaps: new Map<string, string>(),
  chosen: null as string | null,
};

describe('live plan', () => {
  describe('following the plan', () => {
    it('starts at the first set of the first exercise, with its own numbers', () => {
      const plan = buildLivePlan({
        ...base,
        items: [
          item('i1', 'supino', 0, { targetSets: 4, repMin: 6, repMax: 10, restSeconds: 120 }),
        ],
      });

      expect(plan.focus).toMatchObject({
        exerciseId: 'supino',
        setNumber: 1,
        targetSets: 4,
        repMin: 6,
        repMax: 10,
        restSeconds: 120,
        position: 1,
        total: 1,
        extra: false,
        chosen: false,
      });
      expect(plan.planDone).toBe(false);
    });

    it('moves on to the next exercise when the sets of the first are done', () => {
      const plan = buildLivePlan({
        ...base,
        sets: [work('supino'), work('supino'), work('supino')],
      });

      expect(plan.focus).toMatchObject({ exerciseId: 'remada', setNumber: 1, position: 2 });
      expect(plan.entries[0]).toMatchObject({ doneSets: 3, targetSets: 3 });
    });

    it('does not let a warm-up set advance the target', () => {
      const plan = buildLivePlan({ ...base, sets: [warmup('supino')] });

      expect(plan.focus).toMatchObject({ exerciseId: 'supino', setNumber: 1 });
    });

    it('says the plan is done when every set was made', () => {
      const sets = ['supino', 'remada', 'rosca'].flatMap((id) => [work(id), work(id), work(id)]);

      const plan = buildLivePlan({ ...base, sets });

      expect(plan.focus).toBeNull();
      expect(plan.planDone).toBe(true);
    });

    it('does not rest after the last set of the plan', () => {
      const plan = buildLivePlan({
        ...base,
        items: [item('i1', 'supino', 0, { targetSets: 1 })],
      });

      expect(plan.focus?.rest).toBe(false);
    });
  });

  describe('supersets', () => {
    const items = [
      item('a', 'supino', 0, { supersetGroup: 1, targetSets: 2 }),
      item('b', 'triceps', 1, { supersetGroup: 1, targetSets: 2, restSeconds: 60 }),
    ];

    it('goes from one exercise of the pair to the other without rest, and rests after the pair', () => {
      const first = buildLivePlan({ ...base, items });
      expect(first.focus).toMatchObject({ exerciseId: 'supino', rest: false, supersetGroup: 1 });

      const second = buildLivePlan({ ...base, items, sets: [work('supino')] });
      expect(second.focus).toMatchObject({ exerciseId: 'triceps', rest: true, restSeconds: 60 });

      const third = buildLivePlan({ ...base, items, sets: [work('supino'), work('triceps')] });
      expect(third.focus).toMatchObject({ exerciseId: 'supino', setNumber: 2, rest: false });
    });
  });

  describe('a chosen exercise of a superset', () => {
    const pair = [
      item('a', 'supino', 0, { supersetGroup: 1, targetSets: 2 }),
      item('b', 'triceps', 1, { supersetGroup: 1, targetSets: 2, restSeconds: 60 }),
    ];

    it('does not rest in the middle of the pair, even when the exercise was picked from the list', () => {
      const plan = buildLivePlan({ ...base, items: pair, chosen: itemKey('a') });

      expect(plan.focus).toMatchObject({ exerciseId: 'supino', chosen: true, rest: false });
    });

    it('rests when the pick closes the round of the pair', () => {
      const plan = buildLivePlan({
        ...base,
        items: pair,
        sets: [work('supino')],
        chosen: itemKey('b'),
      });

      expect(plan.focus).toMatchObject({ exerciseId: 'triceps', chosen: true, rest: true });
    });
  });

  describe('skipping', () => {
    it('takes the skipped exercise out of the plan and keeps it in the list', () => {
      const plan = buildLivePlan({ ...base, skipped: ['supino'] });

      expect(plan.focus).toMatchObject({ exerciseId: 'remada', position: 2 });
      expect(plan.entries[0]).toMatchObject({ exerciseId: 'supino', skipped: true });
    });

    it('is done when everything left was skipped', () => {
      const plan = buildLivePlan({ ...base, skipped: ['supino', 'remada', 'rosca'] });

      expect(plan.planDone).toBe(true);
    });
  });

  describe('replacing an exercise for today', () => {
    const swaps = new Map([['i1', 'crucifixo']]);

    it('keeps the numbers of the original item and asks for the substitute', () => {
      const plan = buildLivePlan({ ...base, swaps });

      expect(plan.focus).toMatchObject({
        exerciseId: 'crucifixo',
        planExerciseId: 'supino',
        setNumber: 1,
        targetSets: 3,
        position: 1,
        swapped: true,
      });
    });

    it('counts the sets of the substitute against the original item, so a reload goes on where it was', () => {
      const plan = buildLivePlan({ ...base, swaps, sets: [work('crucifixo'), work('crucifixo')] });

      expect(plan.focus).toMatchObject({ exerciseId: 'crucifixo', setNumber: 3, swapped: true });
      expect(plan.entries.filter((entry) => entry.extra)).toEqual([]);
      expect(plan.entries[0]).toMatchObject({ exerciseId: 'crucifixo', doneSets: 2 });
    });

    it('moves on after the last set of the substitute', () => {
      const sets = [work('crucifixo'), work('crucifixo'), work('crucifixo')];

      const plan = buildLivePlan({ ...base, swaps, sets });

      expect(plan.focus).toMatchObject({ exerciseId: 'remada', swapped: false });
    });

    it('keeps the sets already made with the original before the swap', () => {
      const plan = buildLivePlan({ ...base, swaps, sets: [work('supino')] });

      expect(plan.focus).toMatchObject({ exerciseId: 'crucifixo', setNumber: 2 });
    });
  });

  describe('exercises outside the routine', () => {
    it('lists an exercise done outside the routine as an extra, with no target', () => {
      const plan = buildLivePlan({ ...base, sets: [work('flexao')] });

      expect(plan.entries.at(-1)).toMatchObject({
        key: extraKey('flexao'),
        extra: true,
        targetSets: null,
        doneSets: 1,
      });
      expect(plan.focus).toMatchObject({ exerciseId: 'supino' });
    });

    it('lets the person choose the extra, even before its first set, with the default rest', () => {
      const plan = buildLivePlan({ ...base, chosen: extraKey('flexao') });

      expect(plan.focus).toMatchObject({
        exerciseId: 'flexao',
        setNumber: 1,
        targetSets: null,
        restSeconds: 90,
        rest: true,
        extra: true,
        position: null,
        chosen: true,
      });
      expect(plan.entries.map((entry) => entry.key)).toContain(extraKey('flexao'));
    });
  });

  describe('choosing a line', () => {
    it('goes to the chosen exercise, on its next set', () => {
      const plan = buildLivePlan({ ...base, sets: [work('supino')], chosen: itemKey('i2') });

      expect(plan.focus).toMatchObject({ exerciseId: 'remada', setNumber: 1, chosen: true });
    });

    it('offers one more set on an exercise that is already complete, as an extra set', () => {
      const sets = [work('supino'), work('supino'), work('supino')];

      const plan = buildLivePlan({ ...base, sets, chosen: itemKey('i1') });

      expect(plan.focus).toMatchObject({
        exerciseId: 'supino',
        setNumber: 4,
        targetSets: 3,
        extra: true,
        rest: true,
      });
    });
  });

  describe('free workout', () => {
    it('has no focus until an exercise is chosen, and then stays on the last exercise done', () => {
      const none = buildLivePlan({ ...base, items: [] });
      expect(none.focus).toBeNull();
      expect(none.planDone).toBe(false);

      const chosen = buildLivePlan({ ...base, items: [], chosen: extraKey('supino') });
      expect(chosen.focus).toMatchObject({ exerciseId: 'supino', setNumber: 1, total: 0 });

      const going = buildLivePlan({ ...base, items: [], sets: [work('supino'), work('supino')] });
      expect(going.focus).toMatchObject({ exerciseId: 'supino', setNumber: 3, extra: true });
    });
  });
});
