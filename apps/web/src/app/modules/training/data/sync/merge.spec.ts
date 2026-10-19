import { Mergeable, mergeById, newestWins } from './merge';

interface Row extends Mergeable {
  readonly value: string;
  readonly deleted?: boolean;
}

const row = (id: string, clientUpdatedAt: number, value = 'v', deleted = false): Row => ({
  id,
  clientUpdatedAt,
  value,
  deleted,
});

const mapOf = (...rows: Row[]) => new Map(rows.map((r) => [r.id, r]));

describe('mergeById', () => {
  it('writes a remote row that is not in the device yet', () => {
    const remote = row('a', 10);
    expect(mergeById(mapOf(), [remote])).toEqual([remote]);
  });

  it('keeps the local row when it is newer', () => {
    const local = row('a', 20, 'local');
    expect(mergeById(mapOf(local), [row('a', 10, 'remote')])).toEqual([]);
  });

  it('takes the remote row when it is newer', () => {
    const remote = row('a', 30, 'remote');
    expect(mergeById(mapOf(row('a', 20, 'local')), [remote])).toEqual([remote]);
  });

  it('lets the server win a tie, because it already saw everything this device sent', () => {
    const remote = row('a', 20, 'remote');
    expect(mergeById(mapOf(row('a', 20, 'local')), [remote])).toEqual([remote]);
  });

  it('applies a newer tombstone over an older edit', () => {
    const tombstone = row('a', 30, 'v', true);
    expect(mergeById(mapOf(row('a', 20)), [tombstone])).toEqual([tombstone]);
  });

  it('ignores an older tombstone over a newer edit', () => {
    expect(mergeById(mapOf(row('a', 40, 'edited')), [row('a', 30, 'v', true)])).toEqual([]);
  });

  it('lets a newer edit bring a deleted row back', () => {
    const revived = row('a', 50, 'again');
    expect(mergeById(mapOf(row('a', 40, 'v', true)), [revived])).toEqual([revived]);
  });

  it('stores a tombstone for a row the device never had, so an older edit cannot revive it later', () => {
    const tombstone = row('a', 30, 'v', true);
    expect(mergeById(mapOf(), [tombstone])).toEqual([tombstone]);
  });

  it('never removes a local row because the server did not send it', () => {
    const local = mapOf(row('unsent', 5, 'written offline'), row('b', 5));
    const writes = mergeById(local, [row('b', 9, 'newer')]);

    expect(writes.map((r) => r.id)).toEqual(['b']);
    // A função só devolve linhas a gravar: não existe caminho que peça remoção.
    expect(local.has('unsent')).toBe(true);
  });

  it('does not change the map it receives', () => {
    const local = mapOf(row('a', 1));
    mergeById(local, [row('a', 9, 'newer')]);
    expect(local.get('a')?.value).toBe('v');
  });

  it('merges a repeated id in the same batch against the first result', () => {
    const newest = row('a', 30, 'newest');
    const writes = mergeById(mapOf(row('a', 10)), [newest, row('a', 20, 'older')]);
    expect(writes).toEqual([newest]);

    const inOtherOrder = mergeById(mapOf(row('a', 10)), [row('a', 20, 'older'), newest]);
    expect(inOtherOrder).toEqual([newest]);
  });

  it('accepts a custom resolver that composes a third row', () => {
    const merged = mergeById(
      mapOf(row('a', 10, 'local')),
      [row('a', 5, 'remote')],
      (local, remote) => ({ ...local, value: `${local.value}+${remote.value}` }),
    );
    expect(merged).toEqual([row('a', 10, 'local+remote')]);
  });
});

describe('newestWins', () => {
  it('prefers the newer clientUpdatedAt and the remote on a tie', () => {
    const local = row('a', 10, 'local');
    expect(newestWins(local, row('a', 9, 'remote'))).toBe(local);
    expect(newestWins(local, row('a', 10, 'remote')).value).toBe('remote');
    expect(newestWins(local, row('a', 11, 'remote')).value).toBe('remote');
  });
});
