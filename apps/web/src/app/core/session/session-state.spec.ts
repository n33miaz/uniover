import { TestBed } from '@angular/core/testing';
import { SessionState } from './session-state';

describe('SessionState', () => {
  const state = () => TestBed.inject(SessionState);

  it('starts unknown with no token', () => {
    expect(state().status()).toBe('unknown');
    expect(state().bearer()).toBeNull();
    expect(state().hasToken()).toBe(false);
  });

  it('keeps the token in a private field, out of every signal and of JSON', () => {
    state().setToken('eyJ.segredo.token', 600);
    expect(state().status()).toBe('authenticated');
    expect(state().bearer()).toBe('eyJ.segredo.token');
    expect(JSON.stringify(state())).not.toContain('eyJ');
    const observable = Object.values(state()).map((value) =>
      typeof value === 'function' ? value() : value,
    );
    expect(JSON.stringify(observable)).not.toContain('eyJ');
  });

  it('does not hand out an expired token, but still knows it has one', () => {
    state().setToken('t', 10, 1_000);
    expect(state().bearer(5_000)).toBe('t');
    expect(state().bearer(11_000)).toBeNull();
    expect(state().hasToken()).toBe(true);
  });

  it('pending does not demote a session whose token is still valid', () => {
    state().setToken('t', 600);
    state().setPending();
    expect(state().status()).toBe('authenticated');
  });

  it('pending applies when there is no usable token', () => {
    state().setPending();
    expect(state().status()).toBe('pending');
  });

  it('clear forgets token and user', () => {
    state().setToken('t', 600);
    state().setUser({ id: '1', email: 'a@b.c', displayName: 'A' });
    state().clear();
    expect(state().status()).toBe('anonymous');
    expect(state().user()).toBeNull();
    expect(state().bearer()).toBeNull();
    expect(state().expiresAt()).toBeNull();
  });
});
