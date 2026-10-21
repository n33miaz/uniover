import { userCan } from './access';
import { SessionUser } from './session-state';

const person = (role: string | undefined, permissions?: readonly string[]): SessionUser => ({
  id: '1',
  email: 'a@b.c',
  displayName: 'A',
  role,
  permissions,
});

describe('userCan', () => {
  it('lets the owner do everything, even when the list is short or empty', () => {
    expect(userCan(person('owner', ['module:tv']), 'tv:power')).toBe(true);
    expect(userCan(person('owner', []), 'module:training')).toBe(true);
    expect(userCan(person(undefined, ['module:tv']), 'tv:power')).toBe(true);
  });

  it('does not hide anything while the account is not loaded (offline, server waking)', () => {
    expect(userCan(null, 'tv:power')).toBe(true);
  });

  it('does not hide anything from a response with no list (older API): unknown is not "no"', () => {
    expect(userCan(person('guest'), 'tv:power')).toBe(true);
  });

  it('gives a guest exactly what the list brings', () => {
    const guest = person('guest', ['module:tv', 'tv:control']);
    expect(userCan(guest, 'module:tv')).toBe(true);
    expect(userCan(guest, 'tv:control')).toBe(true);
    expect(userCan(guest, 'tv:power')).toBe(false);
    expect(userCan(guest, 'module:training')).toBe(false);
  });

  it('gives a guest with an empty list nothing', () => {
    expect(userCan(person('guest', []), 'module:tv')).toBe(false);
  });
});
