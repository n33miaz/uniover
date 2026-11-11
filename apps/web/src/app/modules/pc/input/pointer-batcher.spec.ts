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
/** Uma vaga só: o comportamento antigo (um pedido em voo), que a maioria dos testes abaixo prova. */
const OPTIONS: BatcherOptions = {
  minIntervalMs: 32,
  maxInFlight: 1,
  maxMove: 2000,
  maxScroll: 1200,
};

describe('PointerBatcher', () => {
  it('sends the first movement right away', () => {
    const { send, batches } = controlledSend();
    new PointerBatcher(send, OPTIONS, fakeClock()).addMove(3, -2);
    expect(batches).toMatchObject([{ dx: 3, dy: -2, scrollX: 0, scrollY: 0 }]);
  });

  it('with a limit of one, keeps ONE request in flight and sums what the finger does meanwhile', async () => {
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
    expect(batches[1]).toMatchObject({ dx: 5, dy: 2, scrollX: 0, scrollY: 120 });
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
      { minIntervalMs: 0, maxInFlight: 1, maxMove: 100, maxScroll: 50 },
      clock,
    );
    batcher.addMove(250, -30);
    expect(batches[0]).toMatchObject({ dx: 100, dy: -30, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
    expect(batches[1]).toMatchObject({ dx: 100, dy: 0, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
    expect(batches[2]).toMatchObject({ dx: 50, dy: 0, scrollX: 0, scrollY: 0 });
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
    expect(batches[1]).toMatchObject({ dx: 4, dy: 0, scrollX: 0, scrollY: 0 });
    finish();
    await draining;
    expect(drained).toBe(true);
    expect(batcher.busy).toBe(false);
  });

  it('discard drops what was waiting (and the wait for the rate) but keeps working afterwards', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.addMove(5, 5);
    batcher.discard();
    finish();
    await flush();
    clock.advance(500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.busy).toBe(false);

    batcher.addMove(7, 7);
    expect(batches[1]).toMatchObject({ dx: 7, dy: 7, scrollX: 0, scrollY: 0 });
    finish();
    await flush();
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

  it('hold buffers the movement and sends nothing until resume, which then flushes it as one request', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.hold();
    batcher.addMove(5, 1);
    batcher.addMove(5, 2);
    batcher.addScroll(0, 120);
    clock.advance(1_000);
    expect(send).not.toHaveBeenCalled();
    expect(batcher.busy).toBe(true);

    batcher.resume();
    expect(batches).toMatchObject([{ dx: 10, dy: 3, scrollX: 0, scrollY: 120 }]);
    finish();
    await flush();
  });

  it('hold also stops the timer of a send that was only waiting for the rate', () => {
    const clock = fakeClock();
    const { send } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.hold();
    batcher.addMove(1, 0);
    clock.advance(1_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('what piles up during a held flight does not leave until resume', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.addMove(1, 0);
    batcher.hold();
    batcher.addMove(2, 0);
    finish();
    await flush();
    clock.advance(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    batcher.resume();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('drain still sends what is held (a click never passes in front of a movement)', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, OPTIONS, clock);
    batcher.hold();
    batcher.addMove(4, 0);
    const draining = batcher.drain();
    expect(batches).toMatchObject([{ dx: 4, dy: 0, scrollX: 0, scrollY: 0 }]);
    finish();
    await draining;
  });
});

describe('PointerBatcher pipelined', () => {
  const PIPELINED: BatcherOptions = { ...OPTIONS, maxInFlight: 4 };

  it('keeps several requests in flight, one per interval, without waiting for any answer', () => {
    const clock = fakeClock();
    const { send, batches } = controlledSend();
    const batcher = new PointerBatcher(send, PIPELINED, clock);
    batcher.addMove(1, 0);
    clock.advance(32);
    batcher.addMove(2, 0);
    clock.advance(32);
    batcher.addMove(3, 0);
    // Nenhuma resposta voltou, e mesmo assim os três já saíram.
    expect(batches.map((b) => b.dx)).toEqual([1, 2, 3]);
    expect(batcher.busy).toBe(true);
  });

  it('still respects the minimum interval between two requests', () => {
    const clock = fakeClock();
    const { send } = controlledSend();
    const batcher = new PointerBatcher(send, PIPELINED, clock);
    batcher.addMove(1, 0);
    batcher.addMove(1, 0);
    expect(send).toHaveBeenCalledTimes(1);
    clock.advance(31);
    expect(send).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('numbers the requests in strictly increasing order and never reuses a number', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...PIPELINED, minIntervalMs: 0 }, clock);
    batcher.addMove(1, 0);
    batcher.addScroll(0, 120);
    batcher.addMove(1, 0);
    finish();
    await flush();
    batcher.discard();
    batcher.addMove(5, 0);
    const seqs = batches.map((b) => b.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBeGreaterThanOrEqual(0);
  });

  it('at the in-flight limit it sums what the finger does and sends it all on the first free slot', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...OPTIONS, maxInFlight: 2 }, clock);
    batcher.addMove(1, 0);
    clock.advance(32);
    batcher.addMove(2, 0);
    clock.advance(32);
    batcher.addMove(3, 0);
    batcher.addMove(4, 0);
    batcher.addMove(5, 0);
    clock.advance(500);
    expect(send).toHaveBeenCalledTimes(2); // cheio: nada mais sai, só soma

    finish();
    await flush();
    expect(batches[2]).toMatchObject({ dx: 12, dy: 0 });
    finish();
    finish();
    await flush();
    expect(batcher.busy).toBe(false);
  });

  it('a failure of one request drops what was waiting but leaves the others in flight alone', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...PIPELINED, maxInFlight: 2 }, clock);
    batcher.addMove(1, 0);
    clock.advance(32);
    batcher.addMove(2, 0);
    batcher.addMove(9, 9); // espera: o limite está cheio
    finish(false);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(batcher.busy).toBe(true); // o segundo ainda voa
    finish();
    await flush();
    expect(batcher.busy).toBe(false);
  });

  it('settleNow sends what is waiting and waits only for the requests that exist at that moment', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...PIPELINED, minIntervalMs: 0 }, clock);
    batcher.addMove(1, 0); // em voo
    batcher.addMove(2, 0); // em voo
    let settled = false;
    const settling = batcher.settleNow().then(() => {
      settled = true;
    });
    batcher.addMove(9, 0); // feito DEPOIS: não entra na espera
    expect(batches.map((b) => b.dx)).toEqual([1, 2, 9]);
    finish();
    finish();
    await settling;
    expect(settled).toBe(true);
    expect(batcher.busy).toBe(true); // o terceiro ainda voa
    finish();
    await flush();
  });

  it('settleNow dispatches the pending movement past the rate and the limit, and does nothing when idle', async () => {
    const clock = fakeClock();
    const { send, batches, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...OPTIONS, maxInFlight: 1 }, clock);
    await batcher.settleNow();
    expect(send).not.toHaveBeenCalled();
    batcher.addMove(1, 0);
    batcher.addMove(6, 0); // espera o voo e a taxa
    const settling = batcher.settleNow();
    expect(batches.map((b) => b.dx)).toEqual([1, 6]);
    finish();
    finish();
    await settling;
  });

  it('drain waits for ALL the requests in flight', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...PIPELINED, minIntervalMs: 0 }, clock);
    batcher.addMove(1, 0);
    batcher.addMove(2, 0);
    batcher.addMove(3, 0);
    expect(send).toHaveBeenCalledTimes(3);
    let drained = false;
    const draining = batcher.drain().then(() => {
      drained = true;
    });
    finish();
    finish();
    await flush();
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it('busy covers the whole set of requests in flight', async () => {
    const clock = fakeClock();
    const { send, finish } = controlledSend();
    const batcher = new PointerBatcher(send, { ...PIPELINED, minIntervalMs: 0 }, clock);
    batcher.addMove(1, 0);
    batcher.addMove(2, 0);
    finish();
    await flush();
    expect(batcher.busy).toBe(true);
    finish();
    await flush();
    expect(batcher.busy).toBe(false);
  });
});

describe('PointerBatcher: interval that follows the path and flush', () => {
  it('uses the interval the provider gives now, not only the fixed one', () => {
    const clock = fakeClock();
    const { send, batches } = controlledSend();
    let interval = 10;
    const batcher = new PointerBatcher(send, { ...OPTIONS, maxInFlight: 4 }, clock, () => interval);
    batcher.addMove(1, 0);
    expect(batches).toHaveLength(1);
    batcher.addMove(2, 0);
    clock.advance(9);
    expect(batches).toHaveLength(1); // ainda dentro dos 10 ms do canal direto
    clock.advance(1);
    expect(batches).toHaveLength(2);

    interval = 32; // o canal caiu: volta o agrupamento da nuvem
    batcher.addMove(3, 0);
    clock.advance(31);
    expect(batches).toHaveLength(2);
    clock.advance(1);
    expect(batches).toHaveLength(3);
  });

  it('flush sends what is waiting right now and does not wait for any answer', () => {
    const clock = fakeClock();
    const { send, batches } = controlledSend();
    const batcher = new PointerBatcher(
      send,
      { ...OPTIONS, maxInFlight: 4, minIntervalMs: 500 },
      clock,
    );
    batcher.addMove(1, 0); // sai já
    batcher.addMove(4, 5); // espera os 500 ms
    batcher.addScroll(0, 7);
    expect(batches).toHaveLength(1);

    batcher.flush();

    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({ dx: 4, dy: 5, scrollY: 7 });
    expect(batcher.busy).toBe(true); // os pedidos seguem em voo: o flush não os espera
  });

  it('flush does nothing when nothing waits, and a stopped batcher drops the leftovers', () => {
    const clock = fakeClock();
    const { send, batches } = controlledSend();
    const batcher = new PointerBatcher(
      send,
      { ...OPTIONS, maxInFlight: 4, minIntervalMs: 500 },
      clock,
    );
    batcher.flush();
    expect(batches).toHaveLength(0);

    batcher.addMove(1, 0);
    batcher.addMove(2, 0);
    batcher.stop();
    batcher.flush();
    expect(batches).toHaveLength(1);
  });
});
