import { item } from '../../shell/screen-test-kit';
import {
  RoutineDraftState,
  appendItem,
  dropItemOn,
  hasErrors,
  isDraftDirty,
  newDraftItem,
  removeItem,
  shiftItem,
  stepItem,
  toSaveDraft,
  toggleLink,
  validateDraft,
} from './routine-draft';

const draft = (
  items = [item('a', 'x1', 0), item('b', 'x2', 1), item('c', 'x3', 2)],
): RoutineDraftState => ({
  id: 'r1',
  name: 'Treino A',
  active: true,
  items,
});

const ids = (items: readonly { id: string }[]) => items.map((entry) => entry.id);

describe('routine draft', () => {
  it('gives a new exercise 3 sets of 8 to 12 repetitions and a 90 s rest', () => {
    expect(newDraftItem('n', 'ex', 4)).toMatchObject({
      id: 'n',
      exerciseId: 'ex',
      position: 4,
      targetSets: 3,
      repMin: 8,
      repMax: 12,
      restSeconds: 90,
      supersetGroup: null,
    });
  });

  it('appends at the end, up to 40 exercises', () => {
    const added = appendItem(draft().items, newDraftItem('d', 'x4', 0))!;
    expect(ids(added)).toEqual(['a', 'b', 'c', 'd']);
    expect(added[3].position).toBe(3);
    const full = Array.from({ length: 40 }, (_, n) => item(`i${n}`, 'x', n));
    expect(appendItem(full, newDraftItem('extra', 'x', 40))).toBeNull();
  });

  it('moves an exercise up and down, and does nothing at the ends', () => {
    expect(ids(shiftItem(draft().items, 'b', -1))).toEqual(['b', 'a', 'c']);
    expect(ids(shiftItem(draft().items, 'b', 1))).toEqual(['a', 'c', 'b']);
    expect(ids(shiftItem(draft().items, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(ids(shiftItem(draft().items, 'c', 1))).toEqual(['a', 'b', 'c']);
    expect(ids(shiftItem(draft().items, 'nada', 1))).toEqual(['a', 'b', 'c']);
  });

  it('drops an exercise on the place of another (dragging)', () => {
    expect(ids(dropItemOn(draft().items, 'a', 'c'))).toEqual(['b', 'c', 'a']);
    expect(ids(dropItemOn(draft().items, 'c', 'a'))).toEqual(['c', 'a', 'b']);
    expect(ids(dropItemOn(draft().items, 'c', 'nada'))).toEqual(['a', 'b', 'c']);
  });

  it('joins an exercise with the next one in a superset, and splits it again', () => {
    const joined = toggleLink(draft().items, 'a');
    expect(joined[0].supersetGroup).not.toBeNull();
    expect(joined[0].supersetGroup).toBe(joined[1].supersetGroup);
    expect(joined[2].supersetGroup).toBeNull();
    const split = toggleLink(joined, 'a');
    expect(split.map((entry) => entry.supersetGroup)).toEqual([null, null, null]);
    // The last one has no "next": nothing changes.
    expect(toggleLink(draft().items, 'c').map((entry) => entry.supersetGroup)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('removes an exercise and closes the gap in the order', () => {
    const rest = removeItem(draft().items, 'b');
    expect(ids(rest)).toEqual(['a', 'c']);
    expect(rest.map((entry) => entry.position)).toEqual([0, 1]);
  });

  it('steps sets, repetitions and rest within the limits, resting in steps of 15 s', () => {
    let items = draft().items;
    items = stepItem(items, 'a', 'targetSets', 1);
    items = stepItem(items, 'a', 'restSeconds', 1);
    items = stepItem(items, 'a', 'repMax', -1);
    expect(items[0]).toMatchObject({ targetSets: 4, restSeconds: 105, repMax: 11 });
    // It does not pass the limits.
    const low = [item('x', 'e', 0, { targetSets: 1, repMin: 1, restSeconds: 0 })];
    expect(stepItem(low, 'x', 'targetSets', -1)[0].targetSets).toBe(1);
    expect(stepItem(low, 'x', 'repMin', -1)[0].repMin).toBe(1);
    expect(stepItem(low, 'x', 'restSeconds', -1)[0].restSeconds).toBe(0);
    const high = [item('x', 'e', 0, { targetSets: 20, repMax: 100, restSeconds: 1800 })];
    expect(stepItem(high, 'x', 'targetSets', 1)[0].targetSets).toBe(20);
    expect(stepItem(high, 'x', 'repMax', 1)[0].repMax).toBe(100);
    expect(stepItem(high, 'x', 'restSeconds', 1)[0].restSeconds).toBe(1800);
  });

  describe('validation', () => {
    it('accepts a named routine with valid exercises', () => {
      expect(hasErrors(validateDraft(draft()))).toBe(false);
    });

    it('asks for a name', () => {
      expect(validateDraft({ ...draft(), name: '  ' }).name).toBe('missing');
      expect(validateDraft({ ...draft(), name: 'a'.repeat(81) }).name).toBe('too-long');
    });

    it('asks for at least one exercise', () => {
      expect(validateDraft({ ...draft(), items: [] }).items).toBe('missing');
    });

    it('points at the exercise whose minimum repetitions pass the maximum', () => {
      const items = [item('a', 'x', 0), item('b', 'y', 1, { repMin: 12, repMax: 8 })];
      const errors = validateDraft(draft(items));
      expect([...errors.reps]).toEqual(['b']);
      expect(hasErrors(errors)).toBe(true);
    });
  });

  it('is dirty only when something changed', () => {
    const start = draft();
    expect(isDraftDirty(start, draft())).toBe(false);
    expect(isDraftDirty(start, { ...start, name: ' Treino A ' })).toBe(false);
    expect(isDraftDirty(start, { ...start, name: 'Treino B' })).toBe(true);
    expect(isDraftDirty(start, { ...start, active: false })).toBe(true);
    expect(isDraftDirty(start, { ...start, items: shiftItem(start.items, 'b', -1) })).toBe(true);
  });

  it('hands the repository the rows in the order of the list, and no id for a new routine', () => {
    const saved = toSaveDraft(draft());
    expect(saved.id).toBe('r1');
    expect(saved.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(toSaveDraft({ ...draft(), id: '' }).id).toBeUndefined();
  });
});
