import { TestBed } from '@angular/core/testing';
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
});
