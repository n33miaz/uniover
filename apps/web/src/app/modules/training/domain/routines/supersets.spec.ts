import { item, items, shape } from './routine-test-kit';
import {
  compactPositions,
  moveItem,
  normalizeItems,
  normalizeSupersets,
  supersetGroups,
  supersetLinks,
  toggleSupersetWithNext,
} from './supersets';

describe('compactPositions', () => {
  it('sorts by position, ties keep the arrival order, and recompacts from zero', () => {
    const result = compactPositions([item('a', 30), item('b', 5), item('c', 5), item('d', 17)]);

    expect(result.map((entry) => entry.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(result.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
  });

  it('does not change its input', () => {
    const input = [item('a', 9), item('b', 1)];

    compactPositions(input);

    expect(input.map((entry) => entry.position)).toEqual([9, 1]);
  });

  it('of an empty list is empty', () => {
    expect(compactPositions([])).toEqual([]);
  });
});

describe('supersetGroups', () => {
  it('returns each run of two or more neighbours with the same group', () => {
    const groups = supersetGroups(items([null, 1, 1, null, 2, 2, 2, 3]));

    expect(groups.map((run) => run.map((entry) => entry.id))).toEqual([
      ['b', 'c'],
      ['e', 'f', 'g'],
    ]);
  });

  it('does not treat a group split by another item as a single superset', () => {
    const groups = supersetGroups(items([1, null, 1]));

    expect(groups).toEqual([]);
  });

  it('is empty when nothing is joined', () => {
    expect(supersetGroups(items([null, null, null]))).toEqual([]);
    expect(supersetGroups([])).toEqual([]);
  });
});

describe('supersetLinks', () => {
  it('marks the items joined to the next one', () => {
    expect(supersetLinks(items([null, 1, 1, 2, 2, null]))).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});

describe('normalizeSupersets', () => {
  it('turns a lone group into no group and renumbers the real ones from 1', () => {
    expect(shape(normalizeSupersets(items([4, 7, 7, null, 9])))).toEqual([
      ['a', null],
      ['b', 1],
      ['c', 1],
      ['d', null],
      ['e', null],
    ]);
  });

  it('splits the same number that comes back after another item into two groups', () => {
    expect(shape(normalizeSupersets(items([1, 1, null, 1, 1])))).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', null],
      ['d', 2],
      ['e', 2],
    ]);
  });

  it('keeps the same references when nothing changes', () => {
    const list = items([null, 1, 1]);

    const result = normalizeSupersets(list);

    expect(result[0]).toBe(list[0]);
    expect(result[1]).toBe(list[1]);
    expect(result[2]).toBe(list[2]);
  });
});

describe('normalizeItems', () => {
  it('sorts, recompacts and normalizes in one step', () => {
    const result = normalizeItems([
      item('c', 30, { supersetGroup: 5 }),
      item('a', 1, { supersetGroup: 5 }),
      item('b', 10),
    ]);

    expect(result.map((entry) => [entry.id, entry.position, entry.supersetGroup])).toEqual([
      ['a', 0, null],
      ['b', 1, null],
      ['c', 2, null],
    ]);
  });
});

describe('toggleSupersetWithNext', () => {
  it('joins an item with the next one', () => {
    expect(shape(toggleSupersetWithNext(items([null, null, null]), 0))).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', null],
    ]);
  });

  it('separates a pair that was joined', () => {
    expect(shape(toggleSupersetWithNext(items([1, 1, null]), 0))).toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
    ]);
  });

  it('grows a pair into a trio and cuts the last link again', () => {
    const trio = toggleSupersetWithNext(items([1, 1, null]), 1);
    expect(shape(trio)).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);

    expect(shape(toggleSupersetWithNext(trio, 1))).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', null],
    ]);
  });

  it('splitting the middle of a trio leaves a pair and a lone item', () => {
    expect(shape(toggleSupersetWithNext(items([1, 1, 1, null]), 0))).toEqual([
      ['a', null],
      ['b', 1],
      ['c', 1],
      ['d', null],
    ]);
  });

  it('merges two neighbouring supersets when the link between them is turned on', () => {
    expect(shape(toggleSupersetWithNext(items([1, 1, 2, 2]), 1))).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 1],
    ]);
  });

  it('does nothing on the last item or out of range', () => {
    expect(shape(toggleSupersetWithNext(items([null, null]), 1))).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(shape(toggleSupersetWithNext(items([null, null]), -1))).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(shape(toggleSupersetWithNext(items([null, null]), 9))).toEqual([
      ['a', null],
      ['b', null],
    ]);
  });
});

describe('moveItem', () => {
  it('moves an item down and recompacts the positions', () => {
    const result = moveItem(items([null, null, null]), 'a', 2);

    expect(result.map((entry) => [entry.id, entry.position])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('moves an item up', () => {
    expect(moveItem(items([null, null, null]), 'c', 0).map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('clamps the target to the ends and ignores an unknown item', () => {
    expect(moveItem(items([null, null, null]), 'a', 99).map((entry) => entry.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(moveItem(items([null, null, null]), 'c', -5).map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(moveItem(items([null, null]), 'zzz', 0).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('swapping the two items of a superset keeps them together', () => {
    expect(shape(moveItem(items([null, 1, 1, null]), 'b', 2))).toEqual([
      ['a', null],
      ['c', 1],
      ['b', 1],
      ['d', null],
    ]);
  });

  it('an item that leaves its superset ends up with no group, and the partner is left alone', () => {
    expect(shape(moveItem(items([1, 1, null, null]), 'a', 3))).toEqual([
      ['b', null],
      ['c', null],
      ['d', null],
      ['a', null],
    ]);
  });

  it('an item dropped between the two items of a superset joins it', () => {
    expect(shape(moveItem(items([null, 1, 1, null]), 'a', 1))).toEqual([
      ['b', 1],
      ['a', 1],
      ['c', 1],
      ['d', null],
    ]);
  });

  it('moving next to a superset without landing inside it does not join it', () => {
    expect(shape(moveItem(items([null, null, 1, 1]), 'a', 1))).toEqual([
      ['b', null],
      ['a', null],
      ['c', 1],
      ['d', 1],
    ]);
  });

  it('never leaves a group split in two', () => {
    const result = moveItem(items([1, 1, 1, null, null]), 'a', 4);

    const supersets = supersetGroups(result);
    expect(supersets).toHaveLength(1);
    expect(supersets[0].map((entry) => entry.id)).toEqual(['b', 'c']);
  });

  it('does not change its input', () => {
    const list = items([null, 1, 1]);

    moveItem(list, 'a', 2);

    expect(list.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
