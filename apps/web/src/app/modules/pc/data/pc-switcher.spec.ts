import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { RELEASE_SETTLE_MS } from './pc-input';
import { PcStore } from './pc-store';
import { PcSwitcher } from './pc-switcher';
import type { PcHoldableKey } from './pc-types';

describe('PcSwitcher', () => {
  let store: FakePcStore;
  let switcher: PcSwitcher;
  let log: string[];

  const flush = async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  };

  /** Um store que segura de verdade: o `DOWN` põe a tecla em `heldKeys` e o soltar a tira. */
  function setup(supported = true) {
    store = createFakePcStore();
    if (supported) store.capabilities.set(['pc.key.v2']);
    log = [];
    store.sendKey.mockImplementation(async (key, modifiers, options) => {
      const mods = modifiers?.length ? '+' + modifiers.join('+') : '';
      if (options?.action === 'DOWN') {
        log.push(`DOWN ${key}`);
        store.heldKeys.set([...store.heldKeys(), key as PcHoldableKey]);
      } else {
        log.push(`${key}${mods}`);
      }
      return null;
    });
    store.releaseKey.mockImplementation(async (key) => {
      log.push(`UP ${key}`);
      store.heldKeys.set(store.heldKeys().filter((held) => held !== key));
      return null;
    });
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    TestBed.inject(SessionState).setUser({
      id: 'ana',
      email: 'ana@exemplo.com',
      displayName: 'ana',
      role: 'owner',
    });
    switcher = TestBed.inject(PcSwitcher);
    TestBed.tick();
  }

  it('holds the Alt and gives the first Tab, in that order', async () => {
    setup();
    expect(switcher.begin()).toBe(true);
    await flush();
    expect(log).toEqual(['DOWN ALT', 'TAB']);
    expect(switcher.active()).toBe(true);
  });

  it('each next is a Tab and each previous a Shift+Tab, with the Alt still held (never sent again)', async () => {
    setup();
    switcher.begin();
    await flush();
    switcher.next();
    switcher.next();
    switcher.previous();
    await flush();
    expect(log).toEqual(['DOWN ALT', 'TAB', 'TAB', 'TAB', 'TAB+SHIFT']);
    expect(log.filter((entry) => entry === 'DOWN ALT')).toHaveLength(1);
  });

  it('beginning again with the Alt held is just another Tab', async () => {
    setup();
    switcher.begin();
    await flush();
    switcher.begin();
    await flush();
    expect(log).toEqual(['DOWN ALT', 'TAB', 'TAB']);
  });

  it('next and previous do nothing when the Alt is not held', async () => {
    setup();
    switcher.next();
    switcher.previous();
    await flush();
    expect(log).toEqual([]);
  });

  it('release lets go of the Alt by its own path, not as a key of the queue', async () => {
    setup();
    switcher.begin();
    await flush();
    await switcher.release();
    expect(log).toEqual(['DOWN ALT', 'TAB', 'UP ALT']);
    expect(store.sendKey.mock.calls.some(([, , options]) => options?.action === 'UP')).toBe(false);
    expect(switcher.active()).toBe(false);
  });

  it('a quick "next, release" lets go only after the last Tab reached the PC', async () => {
    setup();
    switcher.begin();
    await flush();
    let answerTab!: () => void;
    store.sendKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerTab = () => {
            log.push('TAB');
            resolve(null);
          };
        }),
    );
    switcher.next();
    const releasing = switcher.release();
    await flush();
    expect(log).toEqual(['DOWN ALT', 'TAB']); // o Tab ainda não chegou ao PC: o Alt segue
    answerTab();
    await releasing;
    expect(log).toEqual(['DOWN ALT', 'TAB', 'TAB', 'UP ALT']);
  });

  it('a queue that never answers does not keep the Alt held for ever: the release goes after the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setup();
      switcher.begin();
      await vi.advanceTimersByTimeAsync(0);
      store.sendKey.mockImplementationOnce(() => new Promise(() => undefined));
      switcher.next();
      await vi.advanceTimersByTimeAsync(0);
      const releasing = switcher.release();
      await vi.advanceTimersByTimeAsync(RELEASE_SETTLE_MS - 1);
      expect(log).not.toContain('UP ALT');
      await vi.advanceTimersByTimeAsync(1);
      await releasing;
      expect(log).toContain('UP ALT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not available on a PC that does not declare pc.key.v2, and sends nothing there', async () => {
    setup(false);
    expect(switcher.available()).toBe(false);
    expect(switcher.begin()).toBe(false);
    await flush();
    expect(log).toEqual([]);
    expect(store.sendKey).not.toHaveBeenCalled();
  });

  it('with the PC away it sends nothing', async () => {
    setup();
    store.phase.set('offline');
    expect(switcher.begin()).toBe(false);
    await flush();
    expect(log).toEqual([]);
  });

  it('a failed hold drops the Tab behind it (never a bare Tab) and leaves nothing held', async () => {
    setup();
    store.sendKey.mockImplementationOnce(async () => ({ kind: 'offline', message: 'sem PC' }));
    switcher.begin();
    await flush();
    expect(log).toEqual([]);
    expect(switcher.active()).toBe(false);
  });

  it('the state is the one of the store: when the store forgets the key (hide, leave, account, PC lost) it is not active', async () => {
    setup();
    switcher.begin();
    await flush();
    expect(switcher.active()).toBe(true);
    store.heldKeys.set([]);
    expect(switcher.active()).toBe(false);
  });
});
