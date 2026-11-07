import {
  DEFAULT_PAD_GESTURE,
  LONG_PRESS_MS,
  LONG_PRESS_RADIUS_PX,
  PadGesture,
  PadHandlers,
  PadTimers,
} from './pad-gesture';

/** Relógio de mentira: o teste avança o tempo e o disparo da pressão longa acontece quando ele manda. */
function fakeTimers() {
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

function setup() {
  const handlers = {
    move: vi.fn<PadHandlers['move']>(),
    scroll: vi.fn<PadHandlers['scroll']>(),
    tap: vi.fn<PadHandlers['tap']>(),
    dragStart: vi.fn<PadHandlers['dragStart']>(),
    dragEnd: vi.fn<PadHandlers['dragEnd']>(),
  };
  const clock = fakeTimers();
  return { handlers, clock, gesture: new PadGesture(handlers, DEFAULT_PAD_GESTURE, clock.timers) };
}

describe('PadGesture', () => {
  it('a short and still touch is a left click', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 102, 101, 40);
    gesture.up(1, 120);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('LEFT');
    expect(handlers.move).not.toHaveBeenCalled();
  });

  it('a touch that lasts too long is not a click', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.up(1, 600);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('nothing moves until the finger leaves the slop, then the whole path enters at once', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 103, 100, 16);
    expect(handlers.move).not.toHaveBeenCalled();
    gesture.move(1, 110, 100, 32);
    expect(handlers.move).toHaveBeenCalledExactlyOnceWith(10, 0, 32);
    gesture.move(1, 115, 104, 48);
    expect(handlers.move).toHaveBeenLastCalledWith(5, 4, 16);
    gesture.up(1, 64);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('moving and coming back is still a movement, never a click', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 130, 100, 20);
    gesture.move(1, 100, 100, 40);
    gesture.up(1, 60);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('two fingers that move together scroll, by the movement of their center', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 0);
    gesture.move(1, 100, 120, 16);
    gesture.move(2, 140, 120, 16);
    expect(handlers.move).not.toHaveBeenCalled();
    const total = handlers.scroll.mock.calls.reduce((sum, [, dy]) => sum + dy, 0);
    expect(total).toBe(20);
    gesture.up(1, 40);
    gesture.up(2, 40);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('a short and still touch of two fingers is a right click', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 10);
    gesture.up(1, 80);
    gesture.up(2, 90);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('RIGHT');
  });

  it('lifting one finger during a scroll never turns into pointer movement', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 0);
    gesture.move(1, 100, 130, 16);
    gesture.move(2, 140, 130, 16);
    gesture.up(1, 40);
    gesture.move(2, 140, 150, 56);
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenLastCalledWith(0, 20, 40);
    gesture.up(2, 80);
  });

  it('keeps no state between gestures', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 0, 0, 0);
    gesture.move(1, 50, 0, 10);
    gesture.up(1, 20);
    gesture.down(1, 200, 200, 1000);
    gesture.up(1, 1050);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('LEFT');
  });

  it('cancel drops the fingers and fires nothing', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 0, 0, 0);
    expect(gesture.active).toBe(true);
    gesture.cancel();
    expect(gesture.active).toBe(false);
    gesture.up(1, 10);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('ignores movement from a finger it never saw land', () => {
    const { gesture, handlers } = setup();
    gesture.move(9, 50, 50, 10);
    gesture.up(9, 20);
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('passes the time since the last step with the scroll, so the speed of the fingers is known', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 0);
    gesture.move(1, 100, 120, 100);
    gesture.move(2, 140, 120, 100);
    gesture.move(1, 100, 140, 120);
    expect(handlers.scroll.mock.calls.map(([, , elapsed]) => elapsed)).toEqual([100, 0, 20]);
  });
});

describe('PadGesture long press', () => {
  it('a finger held still presses the left button, and lifting it releases (and never clicks)', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    clock.advance(DEFAULT_PAD_GESTURE.longPressMs - 1);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    clock.advance(1);
    expect(handlers.dragStart).toHaveBeenCalledTimes(1);
    expect(gesture.dragging).toBe(true);
    gesture.up(1, 600);
    expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
    expect(gesture.dragging).toBe(false);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('after the press the finger drags: it moves the pointer, and the end is still one release', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    clock.advance(700);
    gesture.move(1, 130, 100, 520);
    expect(handlers.move).toHaveBeenCalledWith(30, 0, expect.any(Number));
    gesture.up(1, 560);
    expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('moving before the time is up is a plain movement: nothing is pressed', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 140, 100, 100);
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    gesture.up(1, 1_100);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    expect(handlers.dragEnd).not.toHaveBeenCalled();
  });

  it('a quick tap never starts the press, and the timer does not outlive the touch', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.up(1, 80);
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('LEFT');
  });

  it('a second finger cancels the press (that is a scroll or a right click)', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 100);
    clock.advance(1_000);
    expect(handlers.dragStart).not.toHaveBeenCalled();
  });

  it('a second finger landing during the press is ignored: it neither scrolls nor ends the drag', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    clock.advance(700);
    gesture.down(2, 140, 100, 520);
    gesture.move(2, 140, 160, 540);
    gesture.up(2, 560);
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.dragEnd).not.toHaveBeenCalled();
    gesture.up(1, 600);
    expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('cancel while pressed releases the button (the system took the touch)', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    clock.advance(700);
    gesture.cancel();
    expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
    gesture.cancel();
    expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('cancel before the time is up leaves nothing scheduled', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.cancel();
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    expect(handlers.dragStart).not.toHaveBeenCalled();
  });

  it('needs 600 ms and a finger within a small radius (named constants)', () => {
    expect(LONG_PRESS_MS).toBe(600);
    expect(DEFAULT_PAD_GESTURE.longPressMs).toBe(LONG_PRESS_MS);
    expect(DEFAULT_PAD_GESTURE.longPressRadiusPx).toBe(LONG_PRESS_RADIUS_PX);
    expect(LONG_PRESS_RADIUS_PX).toBe(8);
    expect(LONG_PRESS_RADIUS_PX).toBe(DEFAULT_PAD_GESTURE.slopPx);
  });

  it('a finger that drifts past the radius during the wait is not a press', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 100 + LONG_PRESS_RADIUS_PX + 1, 100, 100);
    expect(clock.pending).toBe(0);
    clock.advance(2_000);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    gesture.up(1, 2_100);
    expect(handlers.dragEnd).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('a tremor inside the radius keeps the press going', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 102, 101, 100);
    clock.advance(LONG_PRESS_MS);
    expect(handlers.dragStart).toHaveBeenCalledTimes(1);
    gesture.up(1, 800);
  });

  it('a second finger landing at the last moment still cancels it and goes on as a scroll', () => {
    const { gesture, handlers, clock } = setup();
    gesture.down(1, 100, 100, 0);
    clock.advance(LONG_PRESS_MS - 10);
    gesture.down(2, 140, 100, LONG_PRESS_MS - 10);
    clock.advance(1_000);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    gesture.move(1, 100, 130, 700);
    gesture.move(2, 140, 130, 700);
    expect(handlers.scroll).toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
  });
});
