import {
  INERTIA_SWALLOW_MS,
  INERTIA_SWALLOW_SPEED,
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
  let clock: number;

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
    clock = 1_000;
    inertia = new ScrollInertia({
      now: () => clock,
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

describe('ScrollInertia: when a touch only stops it', () => {
  let queue: Map<number, (time: number) => void>;
  let nextHandle: number;
  let time: number;
  let inertia: ScrollInertia;

  function frame(ms = 16) {
    time += ms;
    const [handle, callback] = [...queue][0];
    queue.delete(handle);
    callback(time);
  }

  beforeEach(() => {
    queue = new Map();
    nextHandle = 1;
    time = 0;
    inertia = new ScrollInertia({
      now: () => time,
      frames: {
        request: (callback) => {
          queue.set(nextHandle, callback);
          return nextHandle++;
        },
        cancel: (handle) => void queue.delete(handle),
      },
      scroll: () => undefined,
      canRun: () => true,
      reducedMotion: () => false,
    });
  });

  it('is not visible when nothing is gliding', () => {
    expect(inertia.visible).toBe(false);
    expect(inertia.speed).toBe(0);
    expect(inertia.age).toBe(0);
  });

  it('is visible at the start: fast and young', () => {
    inertia.start(0, 2);
    expect(inertia.visible).toBe(true);
    expect(inertia.speed).toBeGreaterThan(INERTIA_SWALLOW_SPEED);
  });

  it('is still visible while the speed is above the threshold, even after the first moments', () => {
    inertia.start(0, 4);
    for (let step = 0; step < 30; step++) frame();
    expect(inertia.age).toBeGreaterThan(INERTIA_SWALLOW_MS);
    expect(inertia.speed).toBeGreaterThanOrEqual(INERTIA_SWALLOW_SPEED);
    expect(inertia.visible).toBe(true);
  });

  it('is still visible while it is young, even if it was slow from the start', () => {
    inertia.start(0, 0.45);
    frame();
    expect(inertia.speed).toBeLessThan(INERTIA_SWALLOW_SPEED + 0.2);
    for (let step = 0; step < 10; step++) frame();
    expect(inertia.age).toBeLessThan(INERTIA_SWALLOW_MS);
    expect(inertia.visible).toBe(true);
  });

  it('is no longer visible when it is old and has slowed down: a touch there is an ordinary touch', () => {
    inertia.start(0, 0.45);
    for (let step = 0; step < 40 && inertia.active; step++) frame();
    expect(inertia.age === 0 || inertia.age >= INERTIA_SWALLOW_MS).toBe(true);
    expect(inertia.visible).toBe(false);
  });

  it('a slow glide that is old but not over is not visible either', () => {
    inertia.start(0, 0.5);
    time += 600;
    // O relógio andou, os quadros não: a velocidade ainda é a do começo, mas a idade já passou. Rápido o bastante, vale.
    expect(inertia.speed).toBeGreaterThan(INERTIA_SWALLOW_SPEED);
    expect(inertia.visible).toBe(true);
    for (let step = 0; step < 12; step++) frame();
    expect(inertia.speed).toBeLessThan(INERTIA_SWALLOW_SPEED);
    expect(inertia.visible).toBe(false);
  });
});
