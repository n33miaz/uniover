import {
  DEFAULT_ACCELERATION,
  PointerAccelerator,
  WHEEL_UNIT,
  gainFor,
  wheelFromSwipe,
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

describe('wheelFromSwipe', () => {
  it('scrolls down when the fingers go down (the Windows default: a negative wheel)', () => {
    expect(wheelFromSwipe(0, 40).scrollY).toBe(-WHEEL_UNIT);
  });

  it('keeps the horizontal sense: fingers to the right scroll to the right', () => {
    expect(wheelFromSwipe(40, 0).scrollX).toBe(WHEEL_UNIT);
    expect(wheelFromSwipe(-20, 0).scrollX).toBe(-WHEEL_UNIT / 2);
  });
});
