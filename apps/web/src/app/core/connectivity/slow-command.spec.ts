import { TestBed } from '@angular/core/testing';
import { ClientTelemetry } from '../telemetry/client-telemetry';
import { ResumeGrace } from './resume-grace';
import { SLOW_COMMAND_CONFIG, SlowCommandWatch } from './slow-command';

describe('SlowCommandWatch', () => {
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    record = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: ClientTelemetry, useValue: { record } }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows nothing for a command that answers in time', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const done = watch.begin('tv');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(watch.isSlow('tv')).toBe(false);
    done();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watch.isSlow('tv')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('flags a command that passes the limit, only for its module, and clears when it answers', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const done = watch.begin('pc');
    await vi.advanceTimersByTimeAsync(3_100);
    expect(watch.isSlow('pc')).toBe(true);
    expect(watch.isSlow('tv')).toBe(false);
    expect(watch.slowModules()).toEqual(['pc']);
    done();
    expect(watch.isSlow('pc')).toBe(false);
    expect(watch.slowModules()).toEqual([]);
  });

  it('leaves a record (module and limit only) when the notice goes up', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_100);
    expect(record).toHaveBeenCalledWith({ kind: 'command-slow', module: 'tv', code: 'over_3s' });
  });

  it('keeps the notice while any command of the module is still waiting', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const first = watch.begin('tv');
    const second = watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_100);
    first();
    expect(watch.isSlow('tv')).toBe(true);
    second();
    expect(watch.isSlow('tv')).toBe(false);
  });

  it('finishing twice does not break the count', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const done = watch.begin('tv');
    const other = watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_100);
    done();
    done();
    expect(watch.isSlow('tv')).toBe(true);
    other();
    expect(watch.isSlow('tv')).toBe(false);
  });

  it('never shows during the grace period; a command still waiting when it ends is flagged then', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const grace = TestBed.inject(ResumeGrace);
    grace.begin();
    watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_100);
    expect(watch.isSlow('tv')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watch.isSlow('tv')).toBe(true);
  });

  it('a command that answers during the grace period is never flagged', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const grace = TestBed.inject(ResumeGrace);
    grace.begin();
    const done = watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_500);
    done();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(watch.isSlow('tv')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('leaves no timer behind when the service is destroyed', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    watch.begin('tv');
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the limit is per module', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ClientTelemetry, useValue: { record } },
        {
          provide: SLOW_COMMAND_CONFIG,
          useValue: {
            thresholdMs: { tv: 1_000, pc: 5_000, training: 3_000 },
            longThresholdMs: { tv: 30_000, pc: 30_000, training: 30_000 },
          },
        },
      ],
    });
    const watch = TestBed.inject(SlowCommandWatch);
    watch.begin('tv');
    watch.begin('pc');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(watch.isSlow('tv')).toBe(true);
    expect(watch.isSlow('pc')).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(watch.isSlow('pc')).toBe(true);
  });

  it('an action that takes long on purpose is flagged too, only after its longer limit', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const done = watch.begin('tv', 'long');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(watch.isSlow('tv')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(watch.isSlow('tv')).toBe(true);
    expect(record).toHaveBeenCalledWith({ kind: 'command-slow', module: 'tv', code: 'over_30s' });
    done();
    expect(watch.isSlow('tv')).toBe(false);
  });

  it('track follows the promise to the end, success or failure, and gives the result back', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const slowWork = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 3_500));
    const tracked = watch.track('training', slowWork);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(watch.isSlow('training')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await expect(tracked).resolves.toBe('ok');
    expect(watch.isSlow('training')).toBe(false);

    const failing = watch.track('tv', Promise.reject(new Error('falhou')));
    await expect(failing).rejects.toThrow('falhou');
    expect(watch.isSlow('tv')).toBe(false);
  });
});
