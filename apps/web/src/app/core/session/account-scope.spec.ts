import { TestBed } from '@angular/core/testing';
import { AccountScope } from './account-scope';
import { SessionState } from './session-state';

describe('AccountScope', () => {
  const user = { id: 'conta-a', email: 'a@b.c', displayName: 'A' };
  const scope = () => TestBed.inject(AccountScope);
  const session = () => TestBed.inject(SessionState);

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('knows no account until /me answers or a last account is remembered', () => {
    expect(scope().id()).toBeNull();
    expect(scope().sessionAccount()).toBeNull();
  });

  it('uses the remembered account to open the database, but only /me says whose the session is', () => {
    localStorage.setItem('uniover.account-id', 'conta-a');
    TestBed.resetTestingModule();

    expect(scope().id()).toBe('conta-a');
    expect(scope().sessionAccount()).toBeNull();
    expect(scope().isSessionOf('conta-a')).toBe(false);

    session().setUser(user);
    expect(scope().sessionAccount()).toBe('conta-a');
    expect(scope().isSessionOf('conta-a')).toBe(true);
    expect(scope().isSessionOf('conta-b')).toBe(false);
  });

  it('forgets everything on exit', () => {
    session().setUser(user);
    session().clear();

    expect(scope().id()).toBeNull();
    expect(scope().sessionAccount()).toBeNull();
    expect(scope().isSessionOf('conta-a')).toBe(false);
  });

  it('says the first confirmed account owns the old databases, and only it', () => {
    session().setUser(user);
    session().clear();
    session().setUser({ ...user, id: 'conta-b' });

    expect(scope().isLegacyOwner('conta-a')).toBe(true);
    expect(scope().isLegacyOwner('conta-b')).toBe(false);
  });

  it('asks the owner to adopt an old database until it says it finished, and nobody else ever', () => {
    session().setUser(user);

    expect(scope().shouldAdopt('uniover-training', 'conta-a')).toBe(true);
    expect(scope().shouldAdopt('uniover-training', 'conta-b')).toBe(false);

    scope().adoptionFinished('uniover-training', 'conta-a');
    expect(scope().shouldAdopt('uniover-training', 'conta-a')).toBe(false);
    // Cada banco antigo tem a sua conferência.
    expect(scope().shouldAdopt('uniover-offline', 'conta-a')).toBe(true);
  });
});
