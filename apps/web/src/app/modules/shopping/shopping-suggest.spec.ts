import { applyChanges, emptySnapshot, type Snapshot } from './shopping-model';
import { suggestNames } from './shopping-suggest';

function group(...names: string[]): Snapshot {
  return applyChanges(
    emptySnapshot(),
    names.map((name, i) => ({
      sequence: i + 1,
      entityType: 'product',
      entityId: `p${i}`,
      payload: { name, section: '', deleted: false },
    })),
  );
}

describe('suggestNames', () => {
  it('puts what the group already has first, then the common names, starts before middles', () => {
    const names = suggestNames(group('Leite Ninho', 'Creme de leite'), 'lei');
    expect(names[0]).toBe('Leite Ninho');
    expect(names).toContain('Leite');
    expect(names).toContain('Leite condensado');
    expect(names.indexOf('Creme de leite')).toBeGreaterThan(names.indexOf('Leite'));
  });

  it('ignores accents, case, the typed price and the exact name already typed', () => {
    expect(suggestNames(group(), 'ACU')).toContain('Açúcar');
    expect(suggestNames(group(), 'arroz 5,49')).not.toContain('Arroz');
    expect(suggestNames(group(), 'arr 5,49')).toContain('Arroz');
  });

  it('waits for two letters and keeps at most the limit', () => {
    expect(suggestNames(group(), 'a')).toEqual([]);
    expect(suggestNames(group(), 'pa', 3)).toHaveLength(3);
  });

  it('does not repeat a name the group has that is also a common one', () => {
    const names = suggestNames(group('leite'), 'lei');
    expect(names.filter((name) => name.toLowerCase() === 'leite')).toHaveLength(1);
  });
});
