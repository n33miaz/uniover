import { TestBed } from '@angular/core/testing';
import { FakeAccountScope, TEST_ACCOUNT } from '../../../core/offline-queue/queue-test-kit';
import { AccountScope } from '../../../core/session/account-scope';
import { SWAPS_KEY, SwapStore, swapsKey } from './swap-store';

describe('SwapStore', () => {
  let account: FakeAccountScope;

  beforeEach(() => {
    localStorage.clear();
    account = new FakeAccountScope();
    TestBed.configureTestingModule({ providers: [{ provide: AccountScope, useValue: account }] });
  });
  afterEach(() => localStorage.clear());

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
    expect(localStorage.getItem(swapsKey(TEST_ACCOUNT))).toBeNull();
  });

  it('survives a corrupted value', () => {
    localStorage.setItem(swapsKey(TEST_ACCOUNT), '{nao e json');

    expect(TestBed.inject(SwapStore).read('treino-1').size).toBe(0);
  });

  describe('two accounts in the same browser', () => {
    it('keeps the swaps of each one apart: B neither reads nor erases the open workout of A', () => {
      const store = TestBed.inject(SwapStore);
      account.signInAs('conta-a');
      store.write('treino-a', new Map([['item-1', 'crucifixo']]));

      account.signInAs('conta-b');
      expect(store.read('treino-a').size).toBe(0);
      store.write('treino-b', new Map([['item-9', 'remada']]));
      store.clear();

      account.signInAs('conta-a');
      expect(store.read('treino-a')).toEqual(new Map([['item-1', 'crucifixo']]));
      expect(localStorage.getItem(swapsKey('conta-b'))).toBeNull();
    });

    it('stores nothing and reads nothing without a known account', () => {
      account.signInAs(null);
      const store = TestBed.inject(SwapStore);

      store.write('treino-1', new Map([['item-1', 'crucifixo']]));
      expect(store.read('treino-1').size).toBe(0);
      expect(() => store.clear()).not.toThrow();
      expect(localStorage.length).toBe(0);
    });

    it('lets only the owner of the old databases adopt what the single key held, once', () => {
      localStorage.setItem(
        SWAPS_KEY,
        JSON.stringify({ sessionId: 'treino-1', swaps: { 'item-1': 'crucifixo' } }),
      );
      account.legacyOwner = 'conta-a';
      const store = TestBed.inject(SwapStore);

      account.signInAs('conta-b');
      expect(store.read('treino-1').size).toBe(0);
      expect(localStorage.getItem(SWAPS_KEY)).not.toBeNull();

      account.signInAs('conta-a');
      expect(store.read('treino-1')).toEqual(new Map([['item-1', 'crucifixo']]));
      expect(localStorage.getItem(SWAPS_KEY)).toBeNull();
      expect(localStorage.getItem(swapsKey('conta-a'))).not.toBeNull();
    });
  });
});
