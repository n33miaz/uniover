import { TestBed } from '@angular/core/testing';
import { setupSessions } from '../sessions/session-data-test-kit';

let visibility: 'visible' | 'hidden' = 'visible';

/** `navigator.wakeLock` falso: cada pedido devolve um bloqueio que o teste pode soltar como o navegador faria. */
class FakeWakeLock {
  requests = 0;
  failWith: Error | null = null;
  readonly sentinels: FakeSentinel[] = [];

  async request(type: 'screen'): Promise<FakeSentinel> {
    expect(type).toBe('screen');
    this.requests++;
    if (this.failWith) throw this.failWith;
    const sentinel = new FakeSentinel();
    this.sentinels.push(sentinel);
    return sentinel;
  }
}

class FakeSentinel {
  released = false;
  releaseCalls = 0;
  private listener: (() => void) | null = null;

  addEventListener(_type: 'release', listener: () => void): void {
    this.listener = listener;
  }

  async release(): Promise<void> {
    this.releaseCalls++;
    this.released = true;
    this.listener?.();
  }

  /** O sistema solta o bloqueio (aba oculta, bateria baixa...). */
  systemRelease(): void {
    this.released = true;
    this.listener?.();
  }
}

function installWakeLock(lock: FakeWakeLock | undefined) {
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: lock });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WakeLockService', () => {
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>)['visibilityState'];
    delete (navigator as unknown as Record<string, unknown>)['wakeLock'];
  });

  it('requests the screen lock and says it is active', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();

    expect(service.supported()).toBe(true);
    expect(service.active()).toBe(false);

    expect(await service.request()).toBe(true);

    expect(service.active()).toBe(true);
    expect(lock.requests).toBe(1);
  });

  it('does not ask twice while it already holds the lock, even with concurrent calls', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();

    const results = await Promise.all([service.request(), service.request(), service.request()]);
    await service.request();

    expect(results).toEqual([true, true, true]);
    expect(lock.requests).toBe(1);
  });

  it('asks again when the page becomes visible after the system released the lock', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();
    await service.request();

    // A tela bloqueou: o navegador soltou o bloqueio.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    lock.sentinels[0].systemRelease();
    expect(service.active()).toBe(false);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(service.active()).toBe(true);
    expect(lock.requests).toBe(2);
    expect(lock.sentinels).toHaveLength(2);
  });

  it('does not ask again on visibility while it still holds the lock', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();
    await service.request();

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(lock.requests).toBe(1);
  });

  it('releases the lock at the end of the workout and stops asking again', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();
    await service.request();

    await service.release();

    expect(service.active()).toBe(false);
    expect(lock.sentinels[0].releaseCalls).toBe(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(lock.requests).toBe(1);
  });

  it('never breaks the workout when the browser refuses (low battery, no permission)', async () => {
    const lock = new FakeWakeLock();
    lock.failWith = Object.assign(new Error('bateria baixa'), { name: 'NotAllowedError' });
    installWakeLock(lock);
    const service = setupSessions().wakeLock();

    await expect(service.request()).resolves.toBe(false);

    expect(service.active()).toBe(false);
    expect(service.supported()).toBe(true);
    // Voltar a tentar na volta para a página continua possível depois que o navegador deixar.
    lock.failWith = null;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(service.active()).toBe(true);
  });

  it('is unsupported without the API (old iOS) and every call is harmless', async () => {
    installWakeLock(undefined);
    const service = setupSessions().wakeLock();

    expect(service.supported()).toBe(false);
    await expect(service.request()).resolves.toBe(false);
    await expect(service.release()).resolves.toBeUndefined();
    expect(service.active()).toBe(false);
  });

  it('releases a lock that arrives after the workout already ended', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();

    const pending = service.request();
    await service.release();
    expect(await pending).toBe(false);

    expect(service.active()).toBe(false);
    expect(lock.sentinels[0].releaseCalls).toBe(1);
  });

  it('stops listening when it is destroyed', async () => {
    const lock = new FakeWakeLock();
    installWakeLock(lock);
    const service = setupSessions().wakeLock();
    await service.request();
    lock.sentinels[0].systemRelease();

    TestBed.resetTestingModule();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(lock.requests).toBe(1);
    expect(service.active()).toBe(false);
  });
});
