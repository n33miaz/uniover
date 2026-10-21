import { makeShortcut } from '../tv-test-kit';
import { controlRanks, movedOrder, withOrder } from './tv-order';

/**
 * s1, s3 e s5 estão no controle; s2 está fora dele; s4 saiu da TV (a API o entrega como `enabled: false`, e o app não
 * está instalado). Só s1, s3 e s5 aparecem na fileira.
 */
const list = [
  makeShortcut(1),
  makeShortcut(2, { enabled: false }),
  makeShortcut(3),
  makeShortcut(4, { enabled: false, installed: false }),
  makeShortcut(5),
];

describe('controlRanks', () => {
  it('gives a place only to the shortcuts in the control, counting only them', () => {
    const ranks = controlRanks(list);
    expect([...ranks.keys()]).toEqual(['s1', 's3', 's5']);
    expect(ranks.get('s1')).toEqual({ index: 0, count: 3 });
    expect(ranks.get('s3')).toEqual({ index: 1, count: 3 });
    expect(ranks.get('s5')).toEqual({ index: 2, count: 3 });
    expect(ranks.has('s2')).toBe(false);
    expect(ranks.has('s4')).toBe(false);
  });

  it('is empty when nothing is in the control', () => {
    expect(controlRanks([makeShortcut(1, { enabled: false })]).size).toBe(0);
  });
});

describe('movedOrder', () => {
  it('swaps a shortcut with its neighbour in the control, even with others in between, and sends every id', () => {
    // s3 passa para antes de s1: troca de lugar com ele, e s2 e s4 (que a fileira não mostra) ficam onde estavam.
    expect(movedOrder(list, 's3', -1)).toEqual(['s3', 's2', 's1', 's4', 's5']);
    expect(movedOrder(list, 's3', 1)).toEqual(['s1', 's2', 's5', 's4', 's3']);
    expect(movedOrder(list, 's1', 1)).toEqual(['s3', 's2', 's1', 's4', 's5']);
  });

  it('always carries the whole list (the API wants an exact permutation), the ones that left the TV included', () => {
    const ids = movedOrder(list, 's5', -1)!;
    expect(ids).toHaveLength(list.length);
    expect([...ids].sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(ids).toContain('s4');
  });

  it('has nowhere to go at the ends of the row', () => {
    expect(movedOrder(list, 's1', -1)).toBeNull();
    expect(movedOrder(list, 's5', 1)).toBeNull();
  });

  it('does not move what is not in the control, nor what does not exist', () => {
    expect(movedOrder(list, 's2', 1)).toBeNull();
    expect(movedOrder(list, 's4', -1)).toBeNull();
    expect(movedOrder(list, 'nada', 1)).toBeNull();
  });

  it('does not change the list it was given', () => {
    const before = list.map((item) => item.id);
    movedOrder(list, 's3', -1);
    expect(list.map((item) => item.id)).toEqual(before);
  });

  it('is a plain swap when every shortcut is in the control', () => {
    const all = [makeShortcut(1), makeShortcut(2), makeShortcut(3)];
    expect(movedOrder(all, 's2', -1)).toEqual(['s2', 's1', 's3']);
    expect(movedOrder(all, 's2', 1)).toEqual(['s1', 's3', 's2']);
  });
});

describe('withOrder', () => {
  it('puts the list in the order of the ids and renumbers the positions from 1 to n', () => {
    const next = withOrder(list, ['s5', 's4', 's3', 's2', 's1'])!;
    expect(next.map((item) => item.id)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    expect(next.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps every other field of each shortcut', () => {
    const named = [
      makeShortcut(1, { customLabel: 'Sala', iconDataUri: 'data:image/png;base64,AA' }),
    ];
    expect(withOrder(named, ['s1'])).toEqual([{ ...named[0], position: 1 }]);
  });

  it('does not change the list it was given', () => {
    withOrder(list, ['s5', 's4', 's3', 's2', 's1']);
    expect(list.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses anything that is not an exact permutation of the list', () => {
    expect(withOrder(list, ['s1', 's2', 's3', 's4'])).toBeNull();
    expect(withOrder(list, ['s1', 's2', 's3', 's4', 's5', 's6'])).toBeNull();
    expect(withOrder(list, ['s1', 's1', 's3', 's4', 's5'])).toBeNull();
    expect(withOrder(list, ['s1', 's2', 's3', 's4', 'nada'])).toBeNull();
    expect(withOrder(list, [])).toBeNull();
  });
});
