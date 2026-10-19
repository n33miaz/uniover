import { TestBed } from '@angular/core/testing';
import { SessionState } from '../session/session-state';
import { HomeStatusPort } from './home-status.port';

describe('HomeStatusPort (provisional adapter)', () => {
  it('reports "no data" instead of inventing a state', () => {
    expect(TestBed.inject(HomeStatusPort).status()).toEqual({
      userName: null,
      agent: 'unknown',
      watcher: 'unknown',
      serviceDown: false,
    });
  });

  it('takes the user name from the session', () => {
    const status = TestBed.inject(HomeStatusPort).status;
    TestBed.inject(SessionState).setUser({ id: '1', email: 'a@b.c', displayName: 'Neemias' });
    expect(status().userName).toBe('Neemias');
    TestBed.inject(SessionState).clear();
    expect(status().userName).toBeNull();
  });
});
