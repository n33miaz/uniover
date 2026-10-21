import { TestBed } from '@angular/core/testing';
import { SWAPS_KEY, SwapStore } from './swap-store';

describe('SwapStore', () => {
  beforeEach(() => localStorage.removeItem(SWAPS_KEY));

  it('keeps the swaps of the open workout across a reload', () => {
    TestBed.inject(SwapStore).write('treino-1', new Map([['item-1', 'crucifixo']]));

    // Uma instância nova (a página recarregou) lê o mesmo.
    const reloaded = TestBed.runInInjectionContext(() => new SwapStore());
    expect(reloaded.read('treino-1')).toEqual(new Map([['item-1', 'crucifixo']]));
  });

  it('never reads the swaps of another workout', () => {
    const store = TestBed.inject(SwapStore);
    store.write('treino-1', new Map([['item-1', 'crucifixo']]));

    expect(store.read('treino-2').size).toBe(0);
  });

  it('forgets everything on clear', () => {
    const store = TestBed.inject(SwapStore);
    store.write('treino-1', new Map([['item-1', 'crucifixo']]));

    store.clear();

    expect(store.read('treino-1').size).toBe(0);
    expect(localStorage.getItem(SWAPS_KEY)).toBeNull();
  });

  it('survives a corrupted value', () => {
    localStorage.setItem(SWAPS_KEY, '{nao e json');

    expect(TestBed.inject(SwapStore).read('treino-1').size).toBe(0);
  });
});
