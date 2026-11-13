import {
  DEFAULT_ACCELERATION,
  DEFAULT_LEVEL,
  LEGACY_POINTER_LEVEL,
  LEGACY_SCROLL_LEVEL,
  POINTER_GAINS,
  PointerAccelerator,
  SCROLL_GAINS,
  SENSITIVITY_LEVELS,
  ScrollAccelerator,
  WHEEL_UNIT,
  accelerationFor,
  gainFor,
  isSensitivityLevel,
  scrollGainFor,
} from './pc-acceleration';

describe('scroll sensitivity', () => {
  it('offers seven growing levels, the middle one being neutral', () => {
    expect(SENSITIVITY_LEVELS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(SCROLL_GAINS).toHaveLength(7);
    expect(scrollGainFor(DEFAULT_LEVEL)).toBe(1);
    for (let level = 2; level <= 7; level++) {
      expect(SCROLL_GAINS[level - 1]).toBeGreaterThan(SCROLL_GAINS[level - 2]);
    }
  });

  it('keeps the old Low, Normal and High gains as middle points of the slider', () => {
    expect(scrollGainFor(LEGACY_SCROLL_LEVEL.low)).toBe(0.6);
    expect(scrollGainFor(LEGACY_SCROLL_LEVEL.normal)).toBe(1);
    expect(scrollGainFor(LEGACY_SCROLL_LEVEL.high)).toBe(1.6);
  });

  it('scales the wheel steps of the same swipe', () => {
    const wheel = (gain: number) => new ScrollAccelerator().apply(0, 80, 100, false, gain).scrollY;
    expect(Math.abs(wheel(scrollGainFor(2)))).toBeLessThan(Math.abs(wheel(1)));
    expect(Math.abs(wheel(scrollGainFor(6)))).toBeGreaterThan(Math.abs(wheel(1)));
  });

  it('keeps the direction (and the inversion) at any level', () => {
    const accelerator = new ScrollAccelerator();
    expect(accelerator.apply(0, 80, 100, false, 1.6).scrollY).toBeLessThan(0);
    expect(new ScrollAccelerator().apply(0, 80, 100, true, 1.6).scrollY).toBeGreaterThan(0);
  });
});

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
  it('the middle level adds no curve of its own: one pixel of finger is one pixel of pointer at any speed', () => {
    const normal = accelerationFor(DEFAULT_LEVEL);
    expect(gainFor(0, normal)).toBe(1);
    expect(gainFor(50, normal)).toBe(1);
    expect(new PointerAccelerator().apply(40, 0, 5, normal).dx).toBe(40);
  });

  it('the old Low and High keep their exact gains, and Boosted is level 5 with acceleration', () => {
    const low = LEGACY_POINTER_LEVEL.low;
    const high = LEGACY_POINTER_LEVEL.high;
    expect(new PointerAccelerator().apply(10, 0, 5, accelerationFor(low.level)).dx).toBe(7);
    expect(new PointerAccelerator().apply(10, 0, 5, accelerationFor(high.level)).dx).toBe(16);
    const boosted = LEGACY_POINTER_LEVEL.boosted;
    expect(accelerationFor(boosted.level, boosted.acceleration)).toBe(DEFAULT_ACCELERATION);
    const fast = new PointerAccelerator().apply(40, 0, 10, accelerationFor(5, true)).dx;
    expect(fast).toBeGreaterThan(40);
  });

  it('grows level by level, and acceleration scales the curve from the level gain', () => {
    expect(POINTER_GAINS).toHaveLength(7);
    for (let level = 2; level <= 7; level++) {
      expect(POINTER_GAINS[level - 1]).toBeGreaterThan(POINTER_GAINS[level - 2]);
    }
    const slowCurve = accelerationFor(2, true);
    expect(slowCurve.baseGain).toBe(0.7);
    expect(gainFor(50, slowCurve)).toBeGreaterThan(0.7);
    expect(gainFor(50, accelerationFor(7, true))).toBeGreaterThan(
      gainFor(50, DEFAULT_ACCELERATION),
    );
  });

  it('only whole numbers from 1 to 7 are levels', () => {
    expect(isSensitivityLevel(1)).toBe(true);
    expect(isSensitivityLevel(7)).toBe(true);
    for (const bad of [0, 8, 3.5, '4', null, Number.NaN])
      expect(isSensitivityLevel(bad)).toBe(false);
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
