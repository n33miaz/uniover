import { nextRoutine, type SequenceRoutine } from './sequence';

const r = (
  id: string,
  position: number,
  extra: Partial<SequenceRoutine> = {},
): SequenceRoutine => ({
  id,
  position,
  active: true,
  deletedAt: null,
  ...extra,
});

const ABC = [r('a', 0), r('b', 1), r('c', 2)];

describe('nextRoutine', () => {
  it('goes A to B to C and back to A', () => {
    expect(nextRoutine(ABC, 'a')?.id).toBe('b');
    expect(nextRoutine(ABC, 'b')?.id).toBe('c');
    expect(nextRoutine(ABC, 'c')?.id).toBe('a');
  });

  it('with no history is the first by position, whatever the array order', () => {
    expect(nextRoutine(ABC, null)?.id).toBe('a');
    expect(nextRoutine(ABC, undefined)?.id).toBe('a');
    expect(nextRoutine(ABC, '')?.id).toBe('a');
    expect(nextRoutine([r('c', 2), r('a', 0), r('b', 1)], null)?.id).toBe('a');
  });

  it('with an unknown last routine is the first', () => {
    expect(nextRoutine(ABC, 'desconhecida')?.id).toBe('a');
  });

  it('follows the position, not the array order', () => {
    const shuffled = [r('c', 2), r('a', 0), r('b', 1)];

    expect(nextRoutine(shuffled, 'a')?.id).toBe('b');
    expect(nextRoutine(shuffled, 'c')?.id).toBe('a');
  });

  it('skips a deleted routine', () => {
    const list = [r('a', 0), r('b', 1, { deletedAt: 5 }), r('c', 2)];

    expect(nextRoutine(list, 'a')?.id).toBe('c');
    expect(nextRoutine(list, null)?.id).toBe('a');
  });

  it('skips an inactive routine', () => {
    const list = [r('a', 0), r('b', 1, { active: false }), r('c', 2)];

    expect(nextRoutine(list, 'a')?.id).toBe('c');
    expect(nextRoutine(list, 'c')?.id).toBe('a');
  });

  it('skips a deleted first routine when there is no history', () => {
    const list = [r('a', 0, { deletedAt: 1 }), r('b', 1), r('c', 2)];

    expect(nextRoutine(list, null)?.id).toBe('b');
    expect(nextRoutine(list, 'c')?.id).toBe('b');
  });

  it('when the last one done was deleted afterwards, continues from where it stood', () => {
    // A tombstone keeps the position: B was the last and was deleted, so the next is C, not A.
    const list = [r('a', 0), r('b', 1, { deletedAt: 9 }), r('c', 2)];

    expect(nextRoutine(list, 'b')?.id).toBe('c');
  });

  it('when the last one done was deleted at the end, wraps to the first', () => {
    const list = [r('a', 0), r('b', 1), r('c', 2, { deletedAt: 9 })];

    expect(nextRoutine(list, 'c')?.id).toBe('a');
  });

  it('when the last one done was deactivated, continues from where it stood', () => {
    const list = [r('a', 0), r('b', 1, { active: false }), r('c', 2)];

    expect(nextRoutine(list, 'b')?.id).toBe('c');
  });

  it('with a single eligible routine, it is the next one again', () => {
    const list = [r('a', 0), r('b', 1, { deletedAt: 1 })];

    expect(nextRoutine(list, 'a')?.id).toBe('a');
  });

  it('is undefined with nothing eligible', () => {
    expect(nextRoutine([], null)).toBeUndefined();
    expect(
      nextRoutine([r('a', 0, { active: false }), r('b', 1, { deletedAt: 1 })], 'a'),
    ).toBeUndefined();
  });

  it('breaks a position tie by id, always the same way', () => {
    const list = [r('y', 0), r('x', 0)];

    expect(nextRoutine(list, null)?.id).toBe('x');
    expect(nextRoutine(list, 'x')?.id).toBe('y');
  });

  it('returns the very object it was given', () => {
    expect(nextRoutine(ABC, 'a')).toBe(ABC[1]);
  });
});
