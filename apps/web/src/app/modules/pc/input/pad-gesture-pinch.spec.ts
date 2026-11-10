import { DEFAULT_PAD_GESTURE, PadGesture } from './pad-gesture';
import { DEFAULT_PINCH } from './pinch';
import { fakeTimers, setup } from './pad-gesture-test-kit';

/** Dois dedos parados, `gap` pixels um do outro na horizontal, centrados em (200, 200). */
function twoFingers(gesture: PadGesture, gap = 100, at = 0) {
  gesture.down(1, 200 - gap / 2, 200, at);
  gesture.down(2, 200 + gap / 2, 200, at + 5);
}

/** Os dois dedos a `gap` pixels um do outro, o centro parado em (200, 200). */
function spread(gesture: PadGesture, gap: number, at: number) {
  gesture.move(1, 200 - gap / 2, 200, at);
  gesture.move(2, 200 + gap / 2, 200, at);
}

function withPinch() {
  const made = setup();
  made.gesture.configure({ pinchZoom: true });
  return made;
}

const steps = (calls: readonly (readonly [number])[]) => calls.map(([n]) => n);
const total = (calls: readonly (readonly [number])[]) => steps(calls).reduce((a, b) => a + b, 0);

describe('PadGesture: pinch zoom', () => {
  it('fingers that move apart zoom in, whole steps with the remainder kept', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    for (let gap = 110; gap <= 200; gap += 10) spread(gesture, gap, gap * 2);
    gesture.up(1, 500);
    gesture.up(2, 505);
    expect(handlers.zoom).toHaveBeenCalled();
    expect(steps(handlers.zoom.mock.calls).every((n) => n > 0 && Number.isInteger(n))).toBe(true);
    // 100 px a mais, 24 px por passo: 4 passos inteiros
    expect(total(handlers.zoom.mock.calls)).toBe(Math.trunc(100 / DEFAULT_PINCH.pxPerStep));
  });

  it('fingers that move together zoom out, with the negative sign', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 200);
    for (let gap = 190; gap >= 100; gap -= 10) spread(gesture, gap, (200 - gap) * 2);
    gesture.up(1, 500);
    gesture.up(2, 505);
    expect(total(handlers.zoom.mock.calls)).toBe(-Math.trunc(100 / DEFAULT_PINCH.pxPerStep));
    expect(steps(handlers.zoom.mock.calls).every((n) => n < 0)).toBe(true);
  });

  it('a pinch is never a scroll, a right click or a glide, even a quick one', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 80);
    spread(gesture, 160, 20);
    gesture.up(1, 40);
    gesture.up(2, 45); // bem abaixo do tempo de um toque: sem a pinça seria o clique direito
    expect(handlers.zoom).toHaveBeenCalled();
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.scrollEnd).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
  });

  it('is told apart even when only one finger moves (the center walks half as far)', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    // o dedo da direita se afasta 60 px; o centro anda 30, e a distância mudou o dobro dele
    for (let x = 260; x <= 320; x += 10) gesture.move(2, x, 200, x);
    expect(total(handlers.zoom.mock.calls)).toBeGreaterThan(0);
    expect(handlers.scroll).not.toHaveBeenCalled();
  });

  it('once decided, the center walking does not scroll, and the finger left alone does not either', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    spread(gesture, 160, 20);
    gesture.move(1, 120, 260, 40);
    gesture.move(2, 280, 260, 40);
    gesture.up(1, 60);
    gesture.move(2, 300, 300, 80); // o dedo que sobrou anda: não rola, não move
    gesture.up(2, 120);
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.scrollEnd).not.toHaveBeenCalled();
  });

  it('a new gesture after a pinch starts undecided: two fingers that slide together scroll', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    spread(gesture, 180, 20);
    gesture.up(1, 40);
    gesture.up(2, 45);
    handlers.zoom.mockClear();
    twoFingers(gesture, 100, 500);
    for (let dy = 10; dy <= 80; dy += 10) {
      gesture.move(1, 150, 200 + dy, 500 + dy * 2);
      gesture.move(2, 250, 200 + dy, 500 + dy * 2);
    }
    expect(handlers.zoom).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
  });
});

describe('PadGesture: pinch zoom never gets in the way of the two-finger scroll', () => {
  function slide(gesture: PadGesture, drift: number) {
    twoFingers(gesture, 100);
    for (let step = 1; step <= 8; step++) {
      // os dois dedos descem juntos; a distância deriva `drift` px por passo (a mão não é perfeita)
      gesture.move(1, 150 - drift * step, 200 + step * 10, step * 16);
      gesture.move(2, 250 + drift * step, 200 + step * 10, step * 16);
    }
    gesture.up(1, 200);
    gesture.up(2, 205);
  }

  it('a scroll with the fingers steady never zooms', () => {
    const { gesture, handlers } = withPinch();
    slide(gesture, 0);
    expect(handlers.zoom).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
    expect(handlers.scroll.mock.calls.reduce((sum, [, dy]) => sum + dy, 0)).toBeGreaterThan(50);
  });

  it('a scroll with a little drift in the distance never zooms', () => {
    const { gesture, handlers } = withPinch();
    slide(gesture, 0.5);
    expect(handlers.zoom).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
  });

  it('a horizontal scroll does not zoom either', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    for (let step = 1; step <= 8; step++) {
      gesture.move(1, 150 + step * 10, 200, step * 16);
      gesture.move(2, 250 + step * 10, 200, step * 16);
    }
    gesture.up(1, 200);
    gesture.up(2, 205);
    expect(handlers.zoom).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
  });

  it('the scroll that ends fast still glides, with the pinch on', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    for (let step = 1; step <= 8; step++) {
      gesture.move(1, 150, 200 + step * 12, step * 16);
      gesture.move(2, 250, 200 + step * 12, step * 16);
    }
    gesture.up(1, 8 * 16 + 4);
    gesture.up(2, 8 * 16 + 6);
    expect(handlers.scrollEnd).toHaveBeenCalledTimes(1);
  });

  it('with the pinch on, the scroll sends exactly what it sends with the pinch off', () => {
    const run = (pinchZoom: boolean) => {
      const { gesture, handlers } = setup();
      gesture.configure({ pinchZoom });
      slide(gesture, 0.4);
      return {
        scroll: handlers.scroll.mock.calls,
        tap: handlers.tap.mock.calls,
        end: handlers.scrollEnd.mock.calls,
      };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('a short still touch of two fingers is still the right click, with the pinch on', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    gesture.up(1, 60);
    gesture.up(2, 65);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('RIGHT', { x: 200, y: 200 });
    expect(handlers.zoom).not.toHaveBeenCalled();
  });

  it('three fingers are never a pinch', () => {
    const { gesture, handlers } = withPinch();
    gesture.down(1, 100, 200, 0);
    gesture.down(2, 200, 200, 5);
    gesture.down(3, 300, 200, 10);
    gesture.move(1, 60, 200, 20);
    gesture.move(3, 340, 200, 20);
    expect(handlers.zoom).not.toHaveBeenCalled();
  });
});

describe('PadGesture: pinch zoom is off unless it is turned on', () => {
  it('is off by default: the fingers moving apart zoom nothing', () => {
    const handlers = setup().handlers;
    const gesture = new PadGesture(handlers, DEFAULT_PAD_GESTURE, fakeTimers().timers);
    twoFingers(gesture, 100);
    spread(gesture, 200, 20);
    gesture.up(1, 40);
    gesture.up(2, 45);
    expect(handlers.zoom).not.toHaveBeenCalled();
  });

  it('without a zoom handler the pinch does nothing: the fingers do exactly what they do with it off', () => {
    const run = (pinchZoom: boolean) => {
      const { zoom, ...rest } = setup().handlers;
      void zoom;
      const gesture = new PadGesture(rest, DEFAULT_PAD_GESTURE, fakeTimers().timers);
      gesture.configure({ pinchZoom });
      twoFingers(gesture, 100);
      spread(gesture, 220, 20);
      gesture.up(1, 40);
      gesture.up(2, 45);
      return {
        scroll: rest.scroll.mock.calls,
        tap: rest.tap.mock.calls,
        end: rest.scrollEnd.mock.calls,
        move: rest.move.mock.calls,
      };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('turning it off in the middle of the screen takes effect from the next gesture', () => {
    const { gesture, handlers } = withPinch();
    gesture.configure({ pinchZoom: false });
    twoFingers(gesture, 100);
    spread(gesture, 220, 20);
    expect(handlers.zoom).not.toHaveBeenCalled();
  });

  it('cancelling the gesture (the system took the touch) forgets the decision', () => {
    const { gesture, handlers } = withPinch();
    twoFingers(gesture, 100);
    spread(gesture, 180, 20);
    expect(handlers.zoom).toHaveBeenCalled();
    gesture.cancel();
    handlers.zoom.mockClear();
    twoFingers(gesture, 100, 300);
    for (let dy = 10; dy <= 60; dy += 10) {
      gesture.move(1, 150, 200 + dy, 300 + dy);
      gesture.move(2, 250, 200 + dy, 300 + dy);
    }
    expect(handlers.zoom).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
  });
});
