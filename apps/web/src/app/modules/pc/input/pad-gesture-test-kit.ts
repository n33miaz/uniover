import { vi } from 'vitest';
import { DEFAULT_PAD_GESTURE, PadGesture, PadHandlers, PadTimers } from './pad-gesture';

/** Relógio de mentira: o teste avança o tempo e o disparo da pressão longa acontece quando ele manda. */
export function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; handler: () => void }>();
  const timers: PadTimers = {
    set: (handler, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, handler });
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    get pending() {
      return pending.size;
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.handler();
        }
      }
    },
  };
}

/** Um gesto com os pedidos ao resto do app trocados por `vi.fn` e o relógio de mentira. */
export function setup() {
  const handlers = {
    move: vi.fn<PadHandlers['move']>(),
    scroll: vi.fn<PadHandlers['scroll']>(),
    tap: vi.fn<PadHandlers['tap']>(),
    dragStart: vi.fn<PadHandlers['dragStart']>(),
    dragEnd: vi.fn<PadHandlers['dragEnd']>(),
    scrollEnd: vi.fn<NonNullable<PadHandlers['scrollEnd']>>(),
  };
  const clock = fakeTimers();
  const gesture = new PadGesture(handlers, DEFAULT_PAD_GESTURE, clock.timers);
  return { handlers, clock, gesture };
}
