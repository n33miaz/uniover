import { BATCH_EVERY_MS, BATCH_MAX, BATCH_RATE_PER_SECOND, RepeatBatcher } from './repeat-batcher';

describe('RepeatBatcher', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  function setup(busy: () => boolean = () => false) {
    const sent: number[] = [];
    const batcher = new RepeatBatcher((count) => sent.push(count), busy);
    return { sent, batcher };
  }

  it('sends nothing before the first round, then one request per round with the presses owed so far', () => {
    const { sent, batcher } = setup();
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    // 24 por segundo em rodadas de 120 ms são 2,88 por rodada: 2 agora, a fração fica para a próxima.
    expect(sent).toEqual([2]);
    vi.advanceTimersByTime(BATCH_EVERY_MS);
    expect(sent).toEqual([2, 3]);
    batcher.stop();
  });

  it('keeps the average rate asked for, carrying the fraction from round to round', () => {
    const { sent, batcher } = setup();
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS * 25);
    const seconds = (BATCH_EVERY_MS * 25) / 1000;
    const total = sent.reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThanOrEqual(BATCH_RATE_PER_SECOND * seconds - 1);
    expect(total).toBeLessThanOrEqual(BATCH_RATE_PER_SECOND * seconds);
    expect(Math.max(...sent)).toBeLessThanOrEqual(3);
    batcher.stop();
  });

  it('with the queue busy it sends nothing and keeps what is owed, up to the cap; the first free round sends it in one go', () => {
    let busy = true;
    const { sent, batcher } = setup(() => busy);
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS * 30);
    expect(sent).toEqual([]);
    busy = false;
    vi.advanceTimersByTime(BATCH_EVERY_MS);
    expect(sent).toEqual([BATCH_MAX]);
    batcher.stop();
  });

  it('never sends more than the cap in one request', () => {
    let busy = true;
    const { sent, batcher } = setup(() => busy);
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS * 100);
    busy = false;
    vi.advanceTimersByTime(BATCH_EVERY_MS * 10);
    expect(Math.max(...sent)).toBeLessThanOrEqual(BATCH_MAX);
    batcher.stop();
  });

  it('stopping throws away what was owed: nothing goes out after the finger left, and a new start begins from zero', () => {
    let busy = true;
    const { sent, batcher } = setup(() => busy);
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS * 10);
    batcher.stop();
    expect(batcher.active).toBe(false);
    busy = false;
    vi.advanceTimersByTime(BATCH_EVERY_MS * 10);
    expect(sent).toEqual([]);
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS);
    expect(sent).toEqual([2]);
    batcher.stop();
  });

  it('starting again does not run two timers', () => {
    const { sent, batcher } = setup();
    batcher.start();
    batcher.start();
    vi.advanceTimersByTime(BATCH_EVERY_MS);
    expect(sent).toEqual([2]);
    batcher.stop();
  });
});
