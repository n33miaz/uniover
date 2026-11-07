import {
  DEFAULT_ACCELERATION,
  PointerAccelerator,
  ScrollAccelerator,
  WHEEL_UNIT,
  accelerationFor,
  gainFor,
} from './pc-acceleration';

describe('gainFor', () => {
  it('never goes below the base gain, even for a stopped or invalid speed', () => {
    expect(gainFor(0)).toBe(DEFAULT_ACCELERATION.baseGain);
    expect(gainFor(-5)).toBe(DEFAULT_ACCELERATION.baseGain);
    expect(gainFor(Number.NaN)).toBe(DEFAULT_ACCELERATION.baseGain);
  });

  it('grows with the speed and stops at the ceiling', () => {
    expect(gainFor(1)).toBeGreaterThan(gainFor(0.2));
    expect(gainFor(0.2)).toBeGreaterThan(gainFor(0));
    expect(gainFor(50)).toBe(DEFAULT_ACCELERATION.maxGain);
  });
});

describe('PointerAccelerator', () => {
  it('sends a fast swipe farther than the same swipe done slowly', () => {
    const fast = new PointerAccelerator().apply(40, 0, 10);
    const slow = new PointerAccelerator().apply(40, 0, 400);
    expect(fast.dx).toBeGreaterThan(slow.dx);
    expect(slow.dx).toBeGreaterThanOrEqual(40);
  });

  it('keeps the fractional pixels so slow swipes are not lost to rounding', () => {
    const accelerator = new PointerAccelerator({ baseGain: 1, slope: 0, maxGain: 1 });
    // 0,4 px por passo: sozinho cada passo arredondaria para zero.
    const total = Array.from({ length: 10 }, () => accelerator.apply(0.4, 0, 16)).reduce(
      (sum, step) => sum + step.dx,
      0,
    );
    expect(total).toBe(4);
  });

  it('never returns fractions and keeps the sign of the swipe', () => {
    const step = new PointerAccelerator().apply(-7.3, 4.9, 16);
    expect(Number.isInteger(step.dx)).toBe(true);
    expect(Number.isInteger(step.dy)).toBe(true);
    expect(step.dx).toBeLessThan(0);
    expect(step.dy).toBeGreaterThan(0);
  });

  it('treats a zero or negative interval as the shortest possible one', () => {
    const step = new PointerAccelerator().apply(10, 0, 0);
    expect(new PointerAccelerator().apply(10, 0, -4)).toEqual(step);
    expect(new PointerAccelerator().apply(10, 0, 1)).toEqual(step);
  });

  it('a new finger does not inherit the fraction of the previous one', () => {
    const accelerator = new PointerAccelerator({ baseGain: 1, slope: 0, maxGain: 1 });
    accelerator.apply(0.6, 0, 16);
    accelerator.reset();
    expect(accelerator.apply(0.6, 0, 16)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('accelerationFor', () => {
  it('normal adds no curve of its own: one pixel of finger is one pixel of pointer at any speed', () => {
    const normal = accelerationFor('normal');
    expect(gainFor(0, normal)).toBe(1);
    expect(gainFor(50, normal)).toBe(1);
    expect(new PointerAccelerator().apply(40, 0, 5, normal).dx).toBe(40);
  });

  it('low and high scale the pointer evenly, boosted brings the speed curve back', () => {
    expect(new PointerAccelerator().apply(10, 0, 5, accelerationFor('low')).dx).toBe(7);
    expect(new PointerAccelerator().apply(10, 0, 5, accelerationFor('high')).dx).toBe(16);
    expect(accelerationFor('boosted')).toBe(DEFAULT_ACCELERATION);
    const fast = new PointerAccelerator().apply(40, 0, 10, accelerationFor('boosted')).dx;
    expect(fast).toBeGreaterThan(40);
  });
});

const STEADY = { baseGain: 1, slope: 0, maxGain: 1 };

describe('ScrollAccelerator', () => {
  it('scrolls down when the fingers go down (the Windows default: a negative wheel)', () => {
    // Com ganho 1, 40 px valem um clique da roda.
    expect(new ScrollAccelerator(STEADY).apply(0, 40, 400).scrollY).toBe(-WHEEL_UNIT);
  });

  it('keeps the horizontal sense: fingers to the right scroll to the right', () => {
    expect(new ScrollAccelerator(STEADY).apply(40, 0, 400).scrollX).toBe(WHEEL_UNIT);
    expect(new ScrollAccelerator(STEADY).apply(-20, 0, 400).scrollX).toBe(-WHEEL_UNIT / 2);
  });

  it('is proportional to the speed of the fingers: the same swipe done fast goes farther', () => {
    const slow = new ScrollAccelerator().apply(0, 40, 400).scrollY;
    const medium = new ScrollAccelerator().apply(0, 40, 40).scrollY;
    const fast = new ScrollAccelerator().apply(0, 40, 10).scrollY;
    expect(Math.abs(medium)).toBeGreaterThan(Math.abs(slow));
    expect(Math.abs(fast)).toBeGreaterThan(Math.abs(medium));
  });

  it('never goes beyond its ceiling, however fast', () => {
    expect(new ScrollAccelerator().apply(0, 40, 1).scrollY).toBe(-WHEEL_UNIT * 3);
  });

  it('inverting flips both axes (natural scrolling)', () => {
    const step = new ScrollAccelerator(STEADY).apply(40, 40, 400, true);
    expect(step).toEqual({ scrollX: -WHEEL_UNIT, scrollY: WHEEL_UNIT });
  });

  it('keeps the fraction of a wheel unit for the next step and forgets it on reset', () => {
    const scroller = new ScrollAccelerator(STEADY);
    // 0,4 px valem 1,2 unidade: sozinho cada passo perderia a sobra.
    const total = Array.from({ length: 5 }, () => scroller.apply(0.4, 0, 16).scrollX).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(total).toBe(6);
    scroller.apply(0.1, 0, 16);
    scroller.reset();
    expect(scroller.apply(0.1, 0, 16).scrollX).toBe(0);
  });
});
