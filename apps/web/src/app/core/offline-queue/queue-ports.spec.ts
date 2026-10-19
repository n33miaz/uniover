import { TestBed } from '@angular/core/testing';
import { QUEUE_LOCKS, QUEUE_RUNTIME, SYNC_LOCK_NAME, browserQueueLocks } from './queue-ports';

function navigatorWith(locks: unknown): Navigator {
  return { locks } as unknown as Navigator;
}

describe('browserQueueLocks', () => {
  it('runs the task directly in a browser without navigator.locks (one execution per tab is left to the engine)', async () => {
    const locks = browserQueueLocks(navigatorWith(undefined));
    expect(await locks.tryRun(SYNC_LOCK_NAME, () => Promise.resolve(7))).toEqual({
      ran: true,
      value: 7,
    });
    expect(await browserQueueLocks(undefined).tryRun('x', () => Promise.resolve(1))).toEqual({
      ran: true,
      value: 1,
    });
  });

  it('asks for the lock only if it is available and runs the task while holding it', async () => {
    const request = vi.fn(
      (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
        callback({ name: SYNC_LOCK_NAME }),
    );
    const locks = browserQueueLocks(navigatorWith({ request }));

    expect(await locks.tryRun(SYNC_LOCK_NAME, () => Promise.resolve('ok'))).toEqual({
      ran: true,
      value: 'ok',
    });
    expect(request).toHaveBeenCalledWith(
      SYNC_LOCK_NAME,
      { ifAvailable: true },
      expect.any(Function),
    );
  });

  it('does not run the task when another tab holds the lock', async () => {
    const request = (
      _name: string,
      _options: unknown,
      callback: (lock: unknown) => Promise<unknown>,
    ) => callback(null);
    const task = vi.fn(() => Promise.resolve(1));

    const result = await browserQueueLocks(navigatorWith({ request })).tryRun(SYNC_LOCK_NAME, task);

    expect(result).toEqual({ ran: false });
    expect(task).not.toHaveBeenCalled();
  });
});

describe('queue ports defaults', () => {
  it('provides a runtime backed by the real clock and a lock port', () => {
    const runtime = TestBed.inject(QUEUE_RUNTIME);
    const before = Date.now();
    expect(runtime.now()).toBeGreaterThanOrEqual(before);
    expect(runtime.random()).toBeGreaterThanOrEqual(0);
    expect(runtime.random()).toBeLessThan(1);
    expect(TestBed.inject(QUEUE_LOCKS)).toBeDefined();
  });

  it('timers of the default runtime fire and can be cancelled', async () => {
    const runtime = TestBed.inject(QUEUE_RUNTIME);
    const fired = vi.fn();
    runtime.setTimeout(fired, 5);
    const cancelled = vi.fn();
    runtime.clearTimeout(runtime.setTimeout(cancelled, 5));
    let ticks = 0;
    const interval = runtime.setInterval(() => ticks++, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    runtime.clearInterval(interval);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});
