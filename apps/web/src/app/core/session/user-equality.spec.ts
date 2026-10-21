import { samePermissions, sameUser } from './user-equality';

describe('samePermissions', () => {
  it('compares the set, not the order nor the reference', () => {
    expect(samePermissions(['a', 'b'], ['b', 'a'])).toBe(true);
    const list = ['a'];
    expect(samePermissions(list, list)).toBe(true);
  });

  it('tells a smaller, bigger or different set apart', () => {
    expect(samePermissions(['a', 'b'], ['a'])).toBe(false);
    expect(samePermissions(['a'], ['a', 'b'])).toBe(false);
    expect(samePermissions(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('does not let a repeated item stand for a missing one', () => {
    expect(samePermissions(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(samePermissions(['a', 'b'], ['a', 'a'])).toBe(false);
  });

  it('treats an absent list (an older answer) as an empty one', () => {
    expect(samePermissions(undefined, [])).toBe(true);
    expect(samePermissions(null, undefined)).toBe(true);
    expect(samePermissions(undefined, ['a'])).toBe(false);
  });
});

describe('sameUser', () => {
  const user = {
    id: '1',
    email: 'a@b.c',
    displayName: 'A',
    role: 'guest',
    displayNameConfirmed: true,
    permissions: ['module:tv'],
  };

  it('is equal field by field, with the permissions by content', () => {
    expect(sameUser(user, { ...user, permissions: ['module:tv'] })).toBe(true);
    expect(sameUser(null, null)).toBe(true);
  });

  it('tells a missing list (not known) from an empty one (known: nothing allowed)', () => {
    const noList = { ...user, permissions: undefined };
    expect(sameUser(noList, { ...user, permissions: [] })).toBe(false);
    expect(sameUser({ ...user, permissions: [] }, noList)).toBe(false);
    expect(sameUser(noList, { ...noList })).toBe(true);
  });

  it('notices each field that changes', () => {
    expect(sameUser(user, { ...user, id: '2' })).toBe(false);
    expect(sameUser(user, { ...user, email: 'x@y.z' })).toBe(false);
    expect(sameUser(user, { ...user, displayName: 'B' })).toBe(false);
    expect(sameUser(user, { ...user, role: 'owner' })).toBe(false);
    expect(sameUser(user, { ...user, displayNameConfirmed: false })).toBe(false);
    expect(sameUser(user, { ...user, permissions: [] })).toBe(false);
    expect(sameUser(user, { ...user, permissions: undefined })).toBe(false);
    expect(sameUser(user, null)).toBe(false);
    expect(sameUser(null, user)).toBe(false);
  });
});
