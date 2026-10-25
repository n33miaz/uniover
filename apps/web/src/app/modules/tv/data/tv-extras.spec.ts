import {
  EXTRA_KEYS,
  MAIN_EXTRAS_MAX,
  fitColumns,
  TvExtraKey,
  isExtraKey,
  mainExtras,
  supportedExtras,
} from './tv-extras';
import { makeTv } from '../tv-test-kit';

const ALL_CAPS = EXTRA_KEYS.map((extra) => `tv.key.${extra.key}`);
const samsung = makeTv('s', {
  kind: 'samsung',
  capabilities: ['tv.remote', 'tv.kind.samsung', 'tv.key.v3', ...ALL_CAPS],
});

const keys = (list: readonly TvExtraKey[]) => list.map((extra) => extra.key);

describe('supportedExtras', () => {
  it('offers only what the TV declares, from the most to the least important', () => {
    const tv = makeTv('a', {
      capabilities: ['tv.remote', 'tv.key.v3', 'tv.key.BLUE', 'tv.key.GUIDE'],
    });
    expect(keys(supportedExtras(tv))).toEqual(['INPUT', 'GUIDE', 'BLUE']);
  });

  it('counts the Input as supported even for an agent that declares no keys (it was in the old contract)', () => {
    expect(
      keys(supportedExtras(makeTv('old', { capabilities: ['tv.remote', 'tv.kind.samsung'] }))),
    ).toEqual(['INPUT']);
    expect(keys(supportedExtras(null))).toEqual(['INPUT']);
  });

  it('ignores declared keys the app has no button for', () => {
    expect(
      keys(supportedExtras(makeTv('x', { capabilities: ['tv.key.NUM_5', 'tv.key.v3'] }))),
    ).toEqual(['INPUT']);
  });

  it('gives every extra a label and a face (icon, color or short word)', () => {
    for (const extra of EXTRA_KEYS) {
      expect(extra.label.length).toBeGreaterThan(0);
      expect(Boolean(extra.icon) || Boolean(extra.color) || extra.short.length > 0).toBe(true);
    }
    expect(new Set(keys(EXTRA_KEYS)).size).toBe(EXTRA_KEYS.length);
  });
});

describe('isExtraKey', () => {
  it('knows the catalog and nothing else', () => {
    expect(isExtraKey('GUIDE')).toBe(true);
    expect(isExtraKey('POWER')).toBe(false);
    expect(isExtraKey(7)).toBe(false);
  });
});

describe('mainExtras: the grid never has an empty cell', () => {
  const supported = supportedExtras(samsung);
  const grid = (base: number, columns: number, chosen: readonly string[] | null) =>
    mainExtras({ base, columns, supported, chosen });
  const aligned = (base: number, columns: number, chosen: readonly string[] | null) =>
    (base + grid(base, columns, chosen).length) % columns;

  it('fills the single missing cell of a Samsung (seven fixed buttons in four columns) with the Input', () => {
    expect(keys(grid(7, 4, null))).toEqual(['INPUT']);
  });

  it('adds nothing when the grid is already full', () => {
    expect(grid(8, 4, null)).toEqual([]);
    expect(grid(4, 2, null)).toEqual([]);
    expect(grid(3, 3, null)).toEqual([]);
  });

  it('fills as many cells as are missing, with the most important keys', () => {
    expect(keys(grid(7, 3, null))).toEqual(['INPUT', 'GUIDE']);
    expect(keys(grid(6, 4, null))).toEqual(['INPUT', 'GUIDE']);
  });

  it('puts the keys the person chose first, and completes the row with the important ones', () => {
    expect(keys(grid(7, 4, ['BLUE']))).toEqual(['BLUE']);
    expect(keys(grid(7, 4, ['BLUE', 'RED']))).toEqual(['BLUE', 'RED', 'INPUT', 'GUIDE', 'INFO']);
    expect(keys(grid(8, 4, ['BLUE']))).toEqual(['BLUE', 'INPUT', 'GUIDE', 'INFO']);
  });

  it('drops what the TV does not have and what repeats', () => {
    const few = supportedExtras(makeTv('f', { capabilities: ['tv.key.GUIDE'] }));
    expect(
      keys(mainExtras({ base: 7, columns: 4, supported: few, chosen: ['BLUE', 'GUIDE', 'GUIDE'] })),
    ).toEqual(['GUIDE']);
  });

  it('never shows more than the main screen holds', () => {
    expect(
      grid(
        8,
        4,
        EXTRA_KEYS.map((extra) => extra.key),
      ).length,
    ).toBeLessThanOrEqual(MAIN_EXTRAS_MAX);
  });

  it('keeps what the TV has, and changes the columns, when it lacks keys to close the row', () => {
    const only = supportedExtras(makeTv('o', { capabilities: [] }));
    // Sete fixos em três colunas (tamanho grande) e só a Fonte: oito botões fecham em duas colunas.
    expect(keys(mainExtras({ base: 7, columns: 3, supported: only, chosen: null }))).toEqual([
      'INPUT',
    ]);
    expect(fitColumns(8, 3)).toBe(2);
    expect(fitColumns(8, 4)).toBe(4);
    expect(fitColumns(7, 4)).toBeNull();
    // Com escolhas da pessoa vale a conta das colunas pedidas: o que não fecha sai.
    expect(keys(mainExtras({ base: 7, columns: 4, supported: only, chosen: ['BLUE'] }))).toEqual([
      'INPUT',
    ]);
  });

  it('keeps every combination of columns and fixed buttons aligned', () => {
    for (const columns of [2, 3, 4]) {
      for (let base = 3; base <= 8; base++) {
        for (const chosen of [null, [], ['GUIDE'], ['GUIDE', 'RED', 'BLUE'], ['SLEEP']]) {
          expect(aligned(base, columns, chosen)).toBe(0);
        }
      }
    }
  });
});
