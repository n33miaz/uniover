import {
  AuditFilter,
  AuditItem,
  EMPTY_FILTER,
  activeFilterCount,
  isOutcome,
  itemKey,
  resolveQuery,
  sameFilter,
} from './audit-model';

const NOW = new Date('2026-10-21T15:00:00.000Z');

function filter(overrides: Partial<AuditFilter> = {}): AuditFilter {
  return { ...EMPTY_FILTER, ...overrides };
}

describe('resolveQuery', () => {
  it('turns an empty filter into an empty query: nothing is asked of the API', () => {
    expect(resolveQuery(EMPTY_FILTER, NOW)).toEqual({
      person: null,
      modules: [],
      actions: [],
      outcome: null,
      from: null,
    });
  });

  it('carries the person id (never the name), the modules, the action and the outcome', () => {
    const query = resolveQuery(
      filter({
        person: { id: 'conta-1', name: 'Bruno' },
        modules: ['tv', 'devices'],
        action: 'tv.key',
        outcome: 'failure',
      }),
      NOW,
    );
    expect(query).toEqual({
      person: 'conta-1',
      modules: ['tv', 'devices'],
      actions: ['tv.key'],
      outcome: 'failure',
      from: null,
    });
  });

  it.each([
    ['24h', '2026-10-20T15:00:00.000Z'],
    ['7d', '2026-10-14T15:00:00.000Z'],
    ['30d', '2026-09-21T15:00:00.000Z'],
  ] as const)(
    'fixes the start of the period %s as an instant, counted back from now',
    (period, from) => {
      expect(resolveQuery(filter({ period }), NOW).from).toBe(from);
    },
  );
});

describe('activeFilterCount', () => {
  it('counts each kind of filter once, and the modules together', () => {
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
    expect(activeFilterCount(filter({ modules: ['tv', 'devices'] }))).toBe(1);
    expect(
      activeFilterCount(
        filter({
          person: { id: 'a', name: 'A' },
          modules: ['tv'],
          action: 'tv.key',
          outcome: 'denied',
          period: '7d',
        }),
      ),
    ).toBe(5);
  });
});

describe('sameFilter', () => {
  it('ignores the order of the modules and compares the person by id', () => {
    const a = filter({ modules: ['tv', 'devices'], person: { id: 'x', name: 'Ana' } });
    const b = filter({ modules: ['devices', 'tv'], person: { id: 'x', name: 'Ana Maria' } });
    expect(sameFilter(a, b)).toBe(true);
  });

  it('tells filters apart by any field', () => {
    expect(sameFilter(EMPTY_FILTER, filter({ period: '24h' }))).toBe(false);
    expect(sameFilter(EMPTY_FILTER, filter({ outcome: 'success' }))).toBe(false);
    expect(sameFilter(filter({ modules: ['tv'] }), filter({ modules: ['tv', 'devices'] }))).toBe(
      false,
    );
  });
});

describe('itemKey and isOutcome', () => {
  it('names a row by its source and id, because ids are only unique inside one source', () => {
    const item = { module: 'tv', id: 'abc' } as AuditItem;
    expect(itemKey(item)).toBe('tv/abc');
  });

  it('only accepts the three outcomes of the API', () => {
    expect(['success', 'failure', 'denied'].every(isOutcome)).toBe(true);
    expect(isOutcome('Success')).toBe(false);
    expect(isOutcome(null)).toBe(false);
  });
});
