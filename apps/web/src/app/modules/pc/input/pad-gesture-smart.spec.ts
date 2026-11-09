import { PC_CLICK_MAX_GAP_MS } from '../data/pc-types';
import { DEFAULT_PAD_GESTURE, LONG_PRESS_MS, PadGesture } from './pad-gesture';
import { setup } from './pad-gesture-test-kit';

describe('PadGesture: middle click', () => {
  it('a short and still touch of three fingers is the middle click, where the fingers landed', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 5);
    gesture.down(3, 180, 100, 10);
    gesture.up(1, 70);
    gesture.up(2, 75);
    gesture.up(3, 80);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('MIDDLE', { x: 140, y: 100 });
  });

  it('can be turned off, and then three fingers click nothing', () => {
    const { gesture, handlers } = setup();
    gesture.configure({ middleClick: false });
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 5);
    gesture.down(3, 180, 100, 10);
    gesture.up(1, 70);
    gesture.up(2, 75);
    gesture.up(3, 80);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('four fingers click nothing', () => {
    const { gesture, handlers } = setup();
    for (let id = 1; id <= 4; id++) gesture.down(id, 100 + id * 30, 100, id);
    for (let id = 1; id <= 4; id++) gesture.up(id, 60 + id);
    expect(handlers.tap).not.toHaveBeenCalled();
  });
});

describe('PadGesture: tap position', () => {
  it('tells where the finger landed, for the visual feedback', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 123, 45, 0);
    gesture.up(1, 50);
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', { x: 123, y: 45 });
  });

  it('the click of two fingers is where their center landed', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 120, 5);
    gesture.up(1, 70);
    gesture.up(2, 75);
    expect(handlers.tap).toHaveBeenCalledWith('RIGHT', { x: 120, y: 110 });
  });
});

describe('PadGesture: double tap and drag', () => {
  /** Um toque curto no ponto, começando em `at`. */
  function tapAt(gesture: PadGesture, x: number, y: number, at: number) {
    gesture.down(1, x, y, at);
    gesture.up(1, at + 60);
  }

  it('is off by default: the second touch moves the pointer like any other', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    gesture.down(1, 102, 100, 200);
    gesture.move(1, 140, 100, 230);
    expect(handlers.dragStart).not.toHaveBeenCalled();
    expect(handlers.move).toHaveBeenCalled();
  });

  describe('turned on', () => {
    function armed() {
      const parts = setup();
      parts.gesture.configure({ doubleTapDrag: true });
      return parts;
    }

    it('the first tap clicks at once, with no wait', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('LEFT', expect.anything());
    });

    it('touching again soon and walking presses the button first, then the pointer follows the finger', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 102, 101, 200);
      gesture.move(1, 140, 101, 230);
      expect(handlers.dragStart).toHaveBeenCalledTimes(1);
      expect(handlers.move).toHaveBeenCalledWith(38, 0, 30);
      // O botão é apertado antes do primeiro passo do ponteiro.
      expect(handlers.dragStart.mock.invocationCallOrder[0]).toBeLessThan(
        handlers.move.mock.invocationCallOrder[0],
      );
      gesture.move(1, 160, 101, 250);
      expect(handlers.dragStart).toHaveBeenCalledTimes(1);
      gesture.up(1, 300);
      expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
      // Um clique só: o do primeiro toque. Arrastar não clica de novo.
      expect(handlers.tap).toHaveBeenCalledTimes(1);
    });

    it('touching again soon and lifting without walking is a second click (a double click for the PC)', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      tapAt(gesture, 103, 100, 200);
      expect(handlers.tap).toHaveBeenCalledTimes(2);
      expect(handlers.dragStart).not.toHaveBeenCalled();
    });

    it('holding the second touch still also presses (the long press works for it too)', () => {
      const { gesture, handlers, clock } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 100, 100, 200);
      clock.advance(LONG_PRESS_MS);
      expect(handlers.dragStart).toHaveBeenCalledTimes(1);
      gesture.up(1, 800);
      expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
    });

    it('a second touch that comes too late is an ordinary touch', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 100, 100, 60 + DEFAULT_PAD_GESTURE.doubleTapMs + 1);
      gesture.move(1, 140, 100, 400);
      expect(handlers.dragStart).not.toHaveBeenCalled();
    });

    it('a second touch that lands far away is an ordinary touch', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 100 + DEFAULT_PAD_GESTURE.doubleTapRadiusPx + 5, 100, 200);
      gesture.move(1, 200, 100, 230);
      expect(handlers.dragStart).not.toHaveBeenCalled();
    });

    it('a third touch does not chain onto a double tap', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      tapAt(gesture, 100, 100, 200);
      gesture.down(1, 100, 100, 400);
      gesture.move(1, 150, 100, 430);
      expect(handlers.dragStart).not.toHaveBeenCalled();
    });

    it('a long touch is not a tap, so it does not arm the next one', () => {
      const { gesture, handlers } = armed();
      gesture.down(1, 100, 100, 0);
      gesture.up(1, 400);
      gesture.down(1, 100, 100, 450);
      gesture.move(1, 150, 100, 480);
      expect(handlers.dragStart).not.toHaveBeenCalled();
    });

    it('a second finger turns it into a two finger gesture, never a drag', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 100, 100, 200);
      gesture.down(2, 140, 100, 205);
      gesture.move(1, 100, 140, 230);
      gesture.move(2, 140, 140, 230);
      expect(handlers.dragStart).not.toHaveBeenCalled();
      expect(handlers.scroll).toHaveBeenCalled();
    });

    it('a system cancel in the middle of the drag releases the button', () => {
      const { gesture, handlers } = armed();
      tapAt(gesture, 100, 100, 0);
      gesture.down(1, 100, 100, 200);
      gesture.move(1, 150, 100, 230);
      gesture.cancel();
      expect(handlers.dragEnd).toHaveBeenCalledTimes(1);
    });
  });
});

describe('PadGesture: scroll direction lock', () => {
  /** Dois dedos pousam e andam juntos, passo a passo. */
  function twoFingers(gesture: PadGesture, steps: [number, number][]) {
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 0);
    let x = 0;
    let y = 0;
    let time = 0;
    for (const [dx, dy] of steps) {
      x += dx;
      y += dy;
      time += 16;
      gesture.move(1, 100 + x, 100 + y, time);
      gesture.move(2, 140 + x, 100 + y, time);
    }
  }

  it('a mostly vertical start locks vertical: the sideways drift is dropped', () => {
    const { gesture, handlers } = setup();
    twoFingers(gesture, [
      [2, 20],
      [6, 10],
      [-5, 12],
    ]);
    const calls = handlers.scroll.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([dx]) => dx === 0)).toBe(true);
    expect(calls.some(([, dy]) => dy !== 0)).toBe(true);
  });

  it('a mostly horizontal start locks horizontal', () => {
    const { gesture, handlers } = setup();
    twoFingers(gesture, [
      [20, 3],
      [10, 8],
      [14, -9],
    ]);
    const calls = handlers.scroll.mock.calls;
    expect(calls.every(([, dy]) => dy === 0)).toBe(true);
    expect(calls.some(([dx]) => dx !== 0)).toBe(true);
  });

  it('the lock lasts until the fingers leave, and the next gesture chooses again', () => {
    const { gesture, handlers } = setup();
    twoFingers(gesture, [
      [2, 20],
      [40, 1],
    ]);
    expect(handlers.scroll.mock.calls.every(([dx]) => dx === 0)).toBe(true);
    gesture.up(1, 100);
    gesture.up(2, 100);
    handlers.scroll.mockClear();
    twoFingers(gesture, [
      [20, 2],
      [1, 30],
    ]);
    expect(handlers.scroll.mock.calls.every(([, dy]) => dy === 0)).toBe(true);
  });

  it('can be turned off, and then both axes scroll', () => {
    const { gesture, handlers } = setup();
    gesture.configure({ lockScrollAxis: false });
    twoFingers(gesture, [
      [12, 12],
      [6, 10],
    ]);
    expect(handlers.scroll.mock.calls.some(([dx]) => dx !== 0)).toBe(true);
    expect(handlers.scroll.mock.calls.some(([, dy]) => dy !== 0)).toBe(true);
  });

  it('a single finger is never locked: the pointer moves on both axes', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 130, 120, 16);
    expect(handlers.move).toHaveBeenCalledWith(30, 20, 16);
  });
});

describe('PadGesture: how fast the scroll ends', () => {
  function flick(gesture: PadGesture, perStep: number, upAfter: number) {
    gesture.down(1, 100, 100, 0);
    gesture.down(2, 140, 100, 0);
    let y = 100;
    let time = 0;
    for (let step = 0; step < 6; step++) {
      y += perStep;
      time += 16;
      gesture.move(1, 100, y, time);
      gesture.move(2, 140, y, time);
    }
    gesture.up(1, time + upAfter);
    gesture.up(2, time + upAfter);
  }

  it('hands over the speed of the centre of the fingers in px/ms, already locked to its axis', () => {
    const { gesture, handlers } = setup();
    flick(gesture, 32, 4);
    expect(handlers.scrollEnd).toHaveBeenCalledTimes(1);
    const [vx, vy] = handlers.scrollEnd.mock.calls[0];
    expect(vx).toBe(0);
    // 32 px a cada 16 ms são 2 px/ms, medidos numa janela de 90 ms.
    expect(vy).toBeGreaterThan(1.2);
    expect(vy).toBeLessThan(2.4);
  });

  it('a slow finger hands over a slow speed (the receiver decides whether it is worth gliding)', () => {
    const { gesture, handlers } = setup();
    flick(gesture, 9, 4);
    const [, vy] = handlers.scrollEnd.mock.calls[0] ?? [0, 0];
    expect(Math.abs(vy)).toBeLessThan(0.7);
  });

  it('fingers that stopped before leaving hand over nothing', () => {
    const { gesture, handlers } = setup();
    flick(gesture, 32, 200);
    expect(handlers.scrollEnd).not.toHaveBeenCalled();
  });

  it('one finger moving the pointer, a tap, and a system cancel never hand over a speed', () => {
    const { gesture, handlers } = setup();
    gesture.down(1, 100, 100, 0);
    gesture.move(1, 200, 100, 16);
    gesture.up(1, 20);
    gesture.down(1, 100, 100, 100);
    gesture.up(1, 150);
    gesture.down(1, 100, 100, 300);
    gesture.down(2, 140, 100, 300);
    gesture.move(1, 100, 200, 316);
    gesture.cancel();
    expect(handlers.scrollEnd).not.toHaveBeenCalled();
  });
});

describe('PadGesture: the gap of the second tap (for a reliable double click)', () => {
  function tapAt(gesture: PadGesture, x: number, y: number, at: number) {
    gesture.down(1, x, y, at);
    gesture.up(1, at + 60);
  }

  it('the first tap carries no gap: it is only the click', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('LEFT', { x: 100, y: 100 });
  });

  it('the second tap of a double tap carries the time since the first click went out', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0); // o clique sai em 60
    tapAt(gesture, 103, 100, 200); // o clique sai em 260: 200 ms depois
    expect(handlers.tap).toHaveBeenNthCalledWith(2, 'LEFT', { x: 103, y: 100 }, 200);
  });

  it('works with the double tap drag on and off (the click is the same)', () => {
    const { gesture, handlers } = setup();
    gesture.configure({ doubleTapDrag: true });
    tapAt(gesture, 100, 100, 0);
    tapAt(gesture, 100, 100, 150);
    expect(handlers.tap).toHaveBeenNthCalledWith(2, 'LEFT', { x: 100, y: 100 }, 150);
  });

  it('is cut at what the contract allows: a slower second tap still asks for the longest wait', () => {
    const { gesture, handlers } = setup();
    // Cada toque dura 250 ms (ainda é toque) e o segundo pousa 290 ms depois do primeiro sair: 540 ms entre as saídas.
    gesture.down(1, 100, 100, 0);
    gesture.up(1, 250);
    gesture.down(1, 100, 100, 540);
    gesture.up(1, 790);
    expect(handlers.tap).toHaveBeenNthCalledWith(
      2,
      'LEFT',
      { x: 100, y: 100 },
      PC_CLICK_MAX_GAP_MS,
    );
  });

  it('a touch that comes too late is an ordinary tap, with no gap', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    tapAt(gesture, 100, 100, 60 + DEFAULT_PAD_GESTURE.doubleTapMs + 1);
    expect(handlers.tap).toHaveBeenNthCalledWith(2, 'LEFT', { x: 100, y: 100 });
  });

  it('a touch far from the first is an ordinary tap, with no gap', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    tapAt(gesture, 100 + DEFAULT_PAD_GESTURE.doubleTapRadiusPx + 5, 100, 200);
    expect(handlers.tap).toHaveBeenNthCalledWith(2, 'LEFT', { x: 137, y: 100 });
  });

  it('a third tap does not chain onto the double tap: it measures from nothing', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    tapAt(gesture, 100, 100, 200);
    tapAt(gesture, 100, 100, 400);
    expect(handlers.tap).toHaveBeenNthCalledWith(3, 'LEFT', { x: 100, y: 100 });
  });

  it('the right click of two fingers never carries a gap', () => {
    const { gesture, handlers } = setup();
    tapAt(gesture, 100, 100, 0);
    gesture.down(1, 100, 100, 200);
    gesture.down(2, 140, 100, 205);
    gesture.up(1, 250);
    gesture.up(2, 255);
    expect(handlers.tap).toHaveBeenNthCalledWith(2, 'RIGHT', { x: 120, y: 100 });
  });
});
