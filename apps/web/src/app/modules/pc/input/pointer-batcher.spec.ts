import { BatcherOptions, PointerBatch, PointerBatcher } from './pointer-batcher';

/** Relógio de mentira: `now` anda só quando o teste manda, e os timeouts disparam por ele. */
function fakeClock() {
  let time = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    now: () => time,
    setTimeout: (handler: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, handler });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.handler();
        }
      }
    },
  };
}

/** Um envio que só termina quando o teste manda (para provar o que acontece durante o voo). */
function controlledSend() {
  const batches: PointerBatch[] = [];
  const resolvers: ((ok: boolean) => void)[] = [];
  const send = vi.fn((batch: PointerBatch) => {
    batches.push(batch);
    return new Promise<boolean>((resolve) => resolvers.push(resolve));
  });
  return { send, batches, finish: (ok = true) => resolvers.shift()!(ok) };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const OPTIONS: BatcherOptions = { minIntervalMs: 32, maxMove: 2000, maxScroll: 1200 };

describe('PointerBatcher', () => {
  it('sends the first movement right away', () => {
    const { send, batches } = controlledSend();
    new PointerBatcher(send, OPTIONS, fakeClock()).addMove(3, -2);
    expect(batches).toEqual([{ dx: 3, dy: -2, scrollX: 0, scrollY: 0 }]);
  });

  it('keeps ONE request in flight and sums what the finger does meanwhile', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.addMove(2, 1);
    batcher.addMove(3, 1);
    batcher.addScroll(0, 120);
    expect(send).toHaveBeenCalledTimes(1);

    clock.advance(100);
    finish();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(batches[1]).toEqual({ dx: 5, dy: 2, scrollX: 0, scrollY: 120 });
    finish();
    await flush();
    expect(batcher.busy).toBe(false);
  });

  it('never starts two requests closer than the minimum interval', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    finish();
    await flush();
    batcher.addMove(1, 0);
    expect(send).toHaveBeenCalledTimes(1);
    clock.advance(31);
    expect(send).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(send).toHaveBeenCalledTimes(2);
    finish();
    await flush();
  });

  it('caps what one request carries and leaves the rest for the next', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(
      send,
      { minIntervalMs: 0, maxMove: 100, maxScroll: 50 },
      clock,
    );
    batcher.addMove(250, -30);
    expect(batches[0]).toEqual({ dx: 100, dy: -30, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
    expect(batches[1]).toEqual({ dx: 100, dy: 0, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
    expect(batches[2]).toEqual({ dx: 50, dy: 0, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
  });

  it('a failed request drops what was waiting: a late pointer is worse than none', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...OPTIONS, minIntervalMs: 0 }, clock);
    batcher.addMove(1, 0);
    batcher.addMove(9, 9);
    finish(false);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.busy).toBe(false);
  });

  it('a request that throws is treated like a failure and never breaks the next ones', async () => {
    const send = vi
      .fn<(batch: PointerBatch) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('rede'))
      .mockResolvedValue(true);
    const batcher = new PointerBatcher(send, { ...OPTIONS, minIntervalMs: 0 }, fakeClock());
    batcher.addMove(1, 0);
    await flush();
    batcher.addMove(2, 0);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('drain sends what is waiting and returns only when everything arrived', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.addMove(4, 0);
    let drained = false;
    const draining = batcher.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    finish();
    await flush();
    // O resto não esperou o intervalo mínimo: quem pede para esvaziar quer tudo já.
    expect(batches[1]).toEqual({ dx: 4, dy: 0, scrollX: 0, scrollY: 0 });
    finish();
    await draining;
    expect(drained).toBe(true);
    expect(batcher.busy).toBe(false);
  });

  it('stop discards what was waiting and nothing leaves afterwards', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.addMove(5, 5);
    batcher.stop();
    finish();
    await flush();
    batcher.addMove(7, 7);
    clock.advance(500);
    expect(send).toHaveBeenCalledTimes(1);
    await batcher.drain();
  });
});
