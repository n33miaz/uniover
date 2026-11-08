import {
  INERTIA_MAX_SPEED,
  INERTIA_MIN_SPEED,
  INERTIA_STOP_SPEED,
  ScrollInertia,
  inertiaStart,
  inertiaStep,
} from './scroll-inertia';

describe('inertiaStart', () => {
  it('a slow exit does not glide', () => {
    expect(inertiaStart(0, INERTIA_MIN_SPEED - 0.01)).toBeNull();
    expect(inertiaStart(0, 0)).toBeNull();
    expect(inertiaStart(Number.NaN, 1)).toBeNull();
  });

  it('a quick exit keeps its direction and speed', () => {
    expect(inertiaStart(0, 1.5)).toEqual({ vx: 0, vy: 1.5 });
    expect(inertiaStart(-1, 0)).toEqual({ vx: -1, vy: 0 });
  });

  it('a very sharp flick is capped, keeping the direction', () => {
    const velocity = inertiaStart(0, -40)!;
    expect(Math.hypot(velocity.vx, velocity.vy)).toBeCloseTo(INERTIA_MAX_SPEED);
    expect(velocity.vy).toBeLessThan(0);
  });
});

describe('inertiaStep', () => {
  it('slows down by friction and goes less far each step', () => {
    const first = inertiaStep({ vx: 0, vy: 2 }, 16);
    const second = inertiaStep(first.next!, 16);
    expect(first.dy).toBeGreaterThan(0);
    expect(second.dy).toBeGreaterThan(0);
    expect(second.dy).toBeLessThan(first.dy);
    expect(first.next!.vy).toBeLessThan(2);
  });

  it('the distance does not depend on how the time is cut (the same total in one step or in many)', () => {
    const whole = inertiaStep({ vx: 0, vy: 2 }, 160);
    let velocity: { vx: number; vy: number } | null = { vx: 0, vy: 2 };
    let total = 0;
    for (let step = 0; step < 10 && velocity; step++) {
      const result = inertiaStep(velocity, 16);
      total += result.dy;
      velocity = result.next;
    }
    expect(total).toBeCloseTo(whole.dy, 5);
  });

  it('keeps the sign and the axis', () => {
    const step = inertiaStep({ vx: -1.2, vy: 0 }, 16);
    expect(step.dx).toBeLessThan(0);
    expect(step.dy).toBe(0);
  });

  it('ends when the speed falls under the stop speed', () => {
    let velocity: { vx: number; vy: number } | null = { vx: 0, vy: 1 };
    let steps = 0;
    while (velocity && steps < 1_000) {
      velocity = inertiaStep(velocity, 16).next;
      steps++;
    }
    expect(velocity).toBeNull();
    expect(steps).toBeLessThan(1_000);
    expect(steps).toBeGreaterThan(10);
    expect(INERTIA_STOP_SPEED).toBeLessThan(INERTIA_MIN_SPEED);
  });
});

describe('ScrollInertia', () => {
  let queue: Map<number, (time: number) => void>;
  let nextHandle: number;
  let time: number;
  let sent: [number, number, number][];
  let allowed: boolean;
  let reduced: boolean;
  let inertia: ScrollInertia;

  /** Roda o próximo quadro, 16 ms depois do anterior. */
  function frame(ms = 16) {
    time += ms;
    const [handle, callback] = [...queue][0];
    queue.delete(handle);
    callback(time);
  }

  beforeEach(() => {
    queue = new Map();
    nextHandle = 1;
    time = 1_000;
    sent = [];
    allowed = true;
    reduced = false;
    inertia = new ScrollInertia({
      frames: {
        request: (callback) => {
          queue.set(nextHandle, callback);
          return nextHandle++;
        },
        cancel: (handle) => void queue.delete(handle),
      },
      scroll: (dx, dy, dt) => sent.push([dx, dy, dt]),
      canRun: () => allowed,
      reducedMotion: () => reduced,
    });
  });

  it('a quick exit keeps scrolling frame by frame, slower each time, and ends by itself', () => {
    inertia.start(0, 2);
    expect(inertia.active).toBe(true);
    frame();
    frame();
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toBeLessThan(sent[0][1]);
    expect(sent.every(([dx, dy, dt]) => dx === 0 && dy > 0 && dt === 16)).toBe(true);
    let guard = 0;
    while (queue.size > 0 && guard++ < 2_000) frame();
    expect(queue.size).toBe(0);
    expect(inertia.active).toBe(false);
  });

  it('a slow exit sends nothing at all', () => {
    inertia.start(0, 0.2);
    expect(inertia.active).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('stop ends it at once and nothing more is sent (a new touch, hiding the page, leaving the screen)', () => {
    inertia.start(0, 2);
    frame();
    inertia.stop();
    expect(queue.size).toBe(0);
    expect(inertia.active).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('starting again replaces the previous glide', () => {
    inertia.start(0, 2);
    inertia.start(0, -2);
    expect(queue.size).toBe(1);
    frame();
    expect(sent[0][1]).toBeLessThan(0);
  });

  it('stops by itself when the PC can no longer be reached, without sending that frame', () => {
    inertia.start(0, 2);
    frame();
    allowed = false;
    frame();
    expect(sent).toHaveLength(1);
    expect(queue.size).toBe(0);
    expect(inertia.active).toBe(false);
  });

  it('does not start when the PC cannot be reached', () => {
    allowed = false;
    inertia.start(0, 2);
    expect(inertia.active).toBe(false);
  });

  it('does not exist for someone who asked to reduce motion', () => {
    reduced = true;
    inertia.start(0, 3);
    expect(inertia.active).toBe(false);
    expect(queue.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a late frame (a busy tab) does not become a jump', () => {
    inertia.start(0, 2);
    frame(16);
    frame(900);
    expect(sent[1][2]).toBe(50);
  });
});
