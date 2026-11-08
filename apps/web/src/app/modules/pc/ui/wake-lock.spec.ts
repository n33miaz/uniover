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

describe('ScreenWakeLock: pedidos que se cruzam', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    Reflect.deleteProperty(document, 'visibilityState');
  });

  function lockWith(request: () => Promise<ReturnType<typeof fakeSentinel>>) {
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    return new ScreenWakeLock(document);
  }

  it('does not ask a second time while the first request has not answered', async () => {
    let answer!: (sentinel: ReturnType<typeof fakeSentinel>) => void;
    const request = vi.fn(
      () => new Promise<ReturnType<typeof fakeSentinel>>((done) => (answer = done)),
    );
    const lock = lockWith(request);
    lock.start();
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);
    const sentinel = fakeSentinel();
    answer(sentinel);
    await vi.waitFor(() => expect(lock.held).toBe(true));
    expect(sentinel.release).not.toHaveBeenCalled();
    lock.stop();
  });

  it('stop and start while a request is out keep one lock, and the late one is released', async () => {
    const sentinels = [fakeSentinel(), fakeSentinel()];
    const answers: ((sentinel: ReturnType<typeof fakeSentinel>) => void)[] = [];
    const request = vi.fn(
      () => new Promise<ReturnType<typeof fakeSentinel>>((done) => answers.push(done)),
    );
    const lock = lockWith(request);
    lock.start();
    lock.stop();
    lock.start();
    answers[0](sentinels[0]);
    await vi.waitFor(() => expect(lock.held).toBe(true));
    // Só um pedido saiu (o segundo ficou esperando o primeiro) e o bloqueio que chegou é o único.
    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinels[0].release).not.toHaveBeenCalled();
    lock.stop();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
  });

  it('a duplicate lock that arrives while one is held is released, not leaked', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lock = lockWith(request);
    lock.start();
    await vi.waitFor(() => expect(lock.held).toBe(true));
    // Algo força um segundo pedido com o primeiro ainda ativo: o que chega é solto.
    await (lock as unknown as { request(): Promise<void> }).request();
    expect(request).toHaveBeenCalledTimes(1);
    lock.stop();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
  });

  it('releases the lock on purpose when the page is hidden, and asks again when it comes back', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lock = lockWith(request);
    lock.start();
    await vi.waitFor(() => expect(lock.held).toBe(true));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(lock.held).toBe(true));
    expect(request).toHaveBeenCalledTimes(2);
    lock.stop();
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('after stop, a visibility change asks for nothing', async () => {
    const request = vi.fn().mockResolvedValue(fakeSentinel());
    const lock = lockWith(request);
    lock.start();
    await vi.waitFor(() => expect(lock.held).toBe(true));
    lock.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
