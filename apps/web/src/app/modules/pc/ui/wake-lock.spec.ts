import { ScreenWakeLock } from './wake-lock';

function fakeSentinel() {
  const listeners: (() => void)[] = [];
  return {
    release: vi.fn(() => Promise.resolve()),
    addEventListener: (_: 'release', listener: () => void) => listeners.push(listener),
    drop: () => listeners.forEach((listener) => listener()),
  };
}

describe('ScreenWakeLock', () => {
  function install(request: () => Promise<ReturnType<typeof fakeSentinel>>) {
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  it('does nothing where the browser has no Wake Lock', () => {
    const lock = new ScreenWakeLock(document);
    expect(lock.supported).toBe(false);
    lock.start();
    expect(lock.held).toBe(false);
    lock.stop();
  });

  it('asks once, holds, and lets go on stop', async () => {
    const sentinel = fakeSentinel();
    const request = vi.fn(() => Promise.resolve(sentinel));
    install(request);
    const lock = new ScreenWakeLock(document);
    expect(lock.supported).toBe(true);
    lock.start();
    lock.start();
    await vi.waitFor(() => expect(lock.held).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    lock.stop();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });

  it('asks again when the page comes back after the browser dropped the lock', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    install(request);
    const lock = new ScreenWakeLock(document);
    lock.start();
    await vi.waitFor(() => expect(lock.held).toBe(true));
    first.drop();
    expect(lock.held).toBe(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lock.held).toBe(true));
    lock.stop();
  });

  it('survives a refusal', async () => {
    install(() => Promise.reject(new Error('NotAllowedError')));
    const lock = new ScreenWakeLock(document);
    lock.start();
    await Promise.resolve();
    expect(lock.held).toBe(false);
    lock.stop();
  });

  it('releases a lock that arrives after stop', async () => {
    const sentinel = fakeSentinel();
    let resolve!: (value: ReturnType<typeof fakeSentinel>) => void;
    install(() => new Promise((done) => (resolve = done)));
    const lock = new ScreenWakeLock(document);
    lock.start();
    lock.stop();
    resolve(sentinel);
    await vi.waitFor(() => expect(sentinel.release).toHaveBeenCalledTimes(1));
    expect(lock.held).toBe(false);
  });
});
