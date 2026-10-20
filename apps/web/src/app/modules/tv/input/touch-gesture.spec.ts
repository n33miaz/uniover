import { DEFAULT_GESTURE, STEP_PX_BY_SPEED, TouchGesture } from './touch-gesture';

describe('STEP_PX_BY_SPEED', () => {
  it('goes from slow to fast, keeps the normal one as the default and stays above the tap limit', () => {
    expect(STEP_PX_BY_SPEED.normal).toBe(DEFAULT_GESTURE.stepPx);
    expect(STEP_PX_BY_SPEED.slow).toBeGreaterThan(STEP_PX_BY_SPEED.normal);
    expect(STEP_PX_BY_SPEED.fast).toBeLessThan(STEP_PX_BY_SPEED.normal);
    // Se o passo fosse menor que o limite do toque, um toque parado viraria seta.
    expect(STEP_PX_BY_SPEED.fast).toBeGreaterThan(DEFAULT_GESTURE.tapMaxPx);
  });

  it('is read live: a config whose step changes is followed by the gesture without a new one', () => {
    let step = 24;
    const gesture = new TouchGesture({
      ...DEFAULT_GESTURE,
      get stepPx() {
        return step;
      },
    });
    gesture.start(100, 100, 0);
    expect(gesture.move(120, 100)).toBeNull();
    step = 16;
    expect(gesture.move(120, 100)).toBe('RIGHT');
  });
});

describe('TouchGesture', () => {
  let gesture: TouchGesture;
  beforeEach(() => {
    gesture = new TouchGesture();
  });

  describe('tap', () => {
    it('a short, still touch is an OK', () => {
      gesture.start(100, 100, 1_000);
      expect(gesture.end(1_150)).toBe(true);
    });

    it('a touch that stays too long is not an OK (so it never presses OK by accident)', () => {
      gesture.start(100, 100, 1_000);
      expect(gesture.end(1_200)).toBe(false);
      gesture.start(100, 100, 2_000);
      expect(gesture.end(2_450)).toBe(false);
    });

    it('a touch that wanders ten pixels or more is not an OK', () => {
      gesture.start(100, 100, 1_000);
      gesture.move(100, 110);
      expect(gesture.end(1_050)).toBe(false);
    });

    it('a small wobble below the limit is still an OK', () => {
      gesture.start(100, 100, 1_000);
      gesture.move(104, 103);
      expect(gesture.end(1_100)).toBe(true);
    });

    it('a tap ends only once', () => {
      gesture.start(0, 0, 0);
      expect(gesture.end(50)).toBe(true);
      expect(gesture.end(60)).toBe(false);
    });
  });

  describe('slide', () => {
    it('stays quiet below the 24 px step', () => {
      gesture.start(100, 100, 0);
      expect(gesture.move(120, 100)).toBeNull();
      expect(gesture.held).toBeNull();
    });

    it('turns a slide past the step into the arrow of the axis that moved most', () => {
      gesture.start(100, 100, 0);
      expect(gesture.move(130, 105)).toBe('RIGHT');
      expect(gesture.held).toBe('RIGHT');

      gesture.cancel();
      gesture.start(100, 100, 0);
      expect(gesture.move(60, 90)).toBe('LEFT');

      gesture.cancel();
      gesture.start(100, 100, 0);
      expect(gesture.move(105, 60)).toBe('UP');

      gesture.cancel();
      gesture.start(100, 100, 0);
      expect(gesture.move(95, 140)).toBe('DOWN');
    });

    it('reports the arrow once and keeps it held while the finger stays displaced', () => {
      gesture.start(100, 100, 0);
      expect(gesture.move(130, 100)).toBe('RIGHT');
      expect(gesture.move(140, 100)).toBeNull();
      expect(gesture.held).toBe('RIGHT');
    });

    it('changes direction when the dominant axis changes', () => {
      gesture.start(100, 100, 0);
      expect(gesture.move(130, 100)).toBe('RIGHT');
      expect(gesture.move(100, 140)).toBe('DOWN');
      expect(gesture.held).toBe('DOWN');
    });

    it('releases the arrow when the finger comes back inside the limit, and then it is never an OK', () => {
      gesture.start(100, 100, 0);
      gesture.move(130, 100);
      gesture.move(102, 100);
      expect(gesture.held).toBeNull();
      expect(gesture.end(80)).toBe(false);
    });

    it('a slide that ends while held is not an OK', () => {
      gesture.start(100, 100, 0);
      gesture.move(130, 100);
      expect(gesture.end(80)).toBe(false);
      expect(gesture.held).toBeNull();
    });

    it('ignores moves when no finger is down, and after cancel', () => {
      expect(gesture.move(500, 500)).toBeNull();
      gesture.start(0, 0, 0);
      gesture.cancel();
      expect(gesture.move(100, 0)).toBeNull();
      expect(gesture.end(10)).toBe(false);
    });
  });

  it('accepts other limits', () => {
    const custom = new TouchGesture({ stepPx: 10, tapMaxMs: 500, tapMaxPx: 30 });
    custom.start(0, 0, 0);
    expect(custom.move(12, 0)).toBe('RIGHT');
    custom.cancel();
    custom.start(0, 0, 0);
    custom.move(8, 0);
    expect(custom.end(400)).toBe(true);
  });
});
