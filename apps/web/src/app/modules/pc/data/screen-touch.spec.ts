import { vi } from 'vitest';
import { fakeTimers } from '../input/pad-gesture-test-kit';
import {
  DEFAULT_SCREEN_TOUCH,
  ImageView,
  MAX_ZOOM,
  RELATIVE_MAX,
  ScreenTouch,
  type ScreenTouchHandlers,
  tapTarget,
} from './screen-touch';
import type { ScreenMonitor } from './screen-viewer';

const MONITOR: ScreenMonitor = { id: 7, primary: true, width: 1920, height: 1080 };
const BOX = { width: 400, height: 225 };
const LAYOUT = 0xdead_beef;

describe('tapTarget', () => {
  it('maps the corners to 0 and 65535 and the middle to the middle', () => {
    expect(tapTarget(MONITOR, LAYOUT, { x: 0, y: 0 }, BOX)).toEqual({
      m: 7,
      l: LAYOUT,
      u: 0,
      v: 0,
      w: 1920,
      h: 1080,
    });
    expect(tapTarget(MONITOR, LAYOUT, { x: 400, y: 225 }, BOX)).toMatchObject({
      u: RELATIVE_MAX,
      v: RELATIVE_MAX,
    });
    expect(tapTarget(MONITOR, LAYOUT, { x: 200, y: 112.5 }, BOX)).toMatchObject({
      u: 32768,
      v: 32768,
    });
  });

  it('keeps a touch outside the frame on the border', () => {
    expect(tapTarget(MONITOR, LAYOUT, { x: -50, y: 900 }, BOX)).toMatchObject({
      u: 0,
      v: RELATIVE_MAX,
    });
  });

  it('does not produce a target from a point or frame that makes no sense', () => {
    expect(tapTarget(MONITOR, LAYOUT, { x: Number.NaN, y: 1 }, BOX)).toBeNull();
    expect(tapTarget(MONITOR, LAYOUT, { x: 1, y: Number.POSITIVE_INFINITY }, BOX)).toBeNull();
    expect(tapTarget(MONITOR, LAYOUT, { x: 1, y: 1 }, { width: 0, height: 225 })).toBeNull();
  });

  it('carries the monitor id, the size and the layout print the app saw, for any arrangement', () => {
    const left: ScreenMonitor = { id: 0, primary: false, width: 2880, height: 1620 };
    expect(tapTarget(left, LAYOUT, { x: 100, y: 50 }, BOX)).toMatchObject({
      m: 0,
      l: LAYOUT,
      w: 2880,
      h: 1620,
    });
  });
});

describe('ImageView', () => {
  it('starts at 1x and maps points straight through', () => {
    const view = new ImageView(400, 225);
    expect(view.toImage({ x: 120, y: 60 })).toEqual({ x: 120, y: 60 });
  });

  it('zooms around the fingers and maps the same screen point back to the image', () => {
    const view = new ImageView(400, 225);
    view.pinch(2, { x: 200, y: 100 }, 0, 0);
    expect(view.scale).toBe(2);
    expect(view.toImage({ x: 200, y: 100 })).toEqual({ x: 200, y: 100 });
    expect(view.toImage({ x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
  });

  it('pinching while the fingers move keeps the image point that was between them under them', () => {
    const view = new ImageView(400, 225);
    view.pinch(2, { x: 200, y: 100 }, 0, 0);
    // O ponto da imagem sob o centro anterior dos dedos (180, 90)...
    const under = view.toImage({ x: 180, y: 90 });
    // ...os dedos afastam (1,5x) e andam 20 px à direita e 10 px para baixo: o centro novo é (200, 100).
    view.pinch(1.5, { x: 200, y: 100 }, 20, 10);
    expect(view.scale).toBe(3);
    const now = view.toImage({ x: 200, y: 100 });
    expect(now.x).toBeCloseTo(under.x, 9);
    expect(now.y).toBeCloseTo(under.y, 9);
  });

  it('a smaller frame limits the pan and says so, so the page applies the new transform first', () => {
    const view = new ImageView(400, 225);
    view.pinch(1, { x: 0, y: 0 }, 0, 0);
    view.pinch(2, { x: 400, y: 225 }, 0, 0);
    expect([view.panX, view.panY]).toEqual([-400, -225]);
    expect(view.resize(400, 225)).toBe(false);
    expect(view.resize(300, 200)).toBe(true);
    expect([view.panX, view.panY]).toEqual([-300, -200]);
    expect(view.size).toEqual({ width: 300, height: 200 });
  });

  it('never goes past the zoom limits nor leaves the frame', () => {
    const view = new ImageView(400, 225);
    view.pinch(100, { x: 0, y: 0 }, 0, 0);
    expect(view.scale).toBe(MAX_ZOOM);
    view.pinch(0.001, { x: 0, y: 0 }, 0, 0);
    expect(view.scale).toBe(1);
    view.pinch(2, { x: 200, y: 100 }, 900, 900);
    expect(view.panX).toBe(0);
    expect(view.panY).toBe(0);
    view.pinch(1, { x: 0, y: 0 }, -9000, -9000);
    expect(view.panX).toBe(-400);
    expect(view.panY).toBe(-225);
  });

  it('ignores a factor that is not a positive number', () => {
    const view = new ImageView(400, 225);
    view.pinch(Number.NaN, { x: 0, y: 0 }, 5, 5);
    view.pinch(-1, { x: 0, y: 0 }, 5, 5);
    expect(view.scale).toBe(1);
  });
});

function setup() {
  const handlers = {
    tap: vi.fn<ScreenTouchHandlers['tap']>(),
    drag: vi.fn<ScreenTouchHandlers['drag']>(),
    pinch: vi.fn<ScreenTouchHandlers['pinch']>(),
    scroll: vi.fn<ScreenTouchHandlers['scroll']>(),
  };
  const clock = fakeTimers();
  let now = 0;
  const touch = new ScreenTouch(handlers, DEFAULT_SCREEN_TOUCH, clock.timers);
  const at = (ms: number) => {
    clock.advance(ms);
    now += ms;
    return now;
  };
  return { handlers, touch, at };
}

describe('ScreenTouch', () => {
  it('a short tap is a left click, sent only after the double-tap wait', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 50, 60, at(0));
    touch.up(1, at(80));
    expect(handlers.tap).not.toHaveBeenCalled();
    at(DEFAULT_SCREEN_TOUCH.doubleTapMs);
    expect(handlers.tap).toHaveBeenCalledOnce();
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', 'CLICK', { x: 50, y: 60 });
  });

  it('two quick taps are one double click, never a click plus a double', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 50, 60, at(0));
    touch.up(1, at(70));
    touch.down(1, 54, 62, at(20));
    touch.up(1, at(70));
    at(1000);
    expect(handlers.tap).toHaveBeenCalledOnce();
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', 'DOUBLE', { x: 54, y: 62 });
  });

  it('a second tap far from the first sends the first as a click and starts over', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 10, 10, at(0));
    touch.up(1, at(60));
    touch.down(1, 300, 200, at(60));
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', 'CLICK', { x: 10, y: 10 });
    touch.up(1, at(60));
    at(1000);
    expect(handlers.tap).toHaveBeenLastCalledWith('LEFT', 'CLICK', { x: 300, y: 200 });
    expect(handlers.tap).toHaveBeenCalledTimes(2);
  });

  it('a long press without moving is a right click, and lifting afterwards does nothing more', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 80, 90, at(0));
    at(DEFAULT_SCREEN_TOUCH.longPressMs);
    expect(handlers.tap).toHaveBeenCalledWith('RIGHT', 'CLICK', { x: 80, y: 90 });
    touch.up(1, at(50));
    at(1000);
    expect(handlers.tap).toHaveBeenCalledOnce();
  });

  it('a finger that walks off is neither a click nor a right click', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 80, 90, at(0));
    touch.move(1, 140, 90);
    at(DEFAULT_SCREEN_TOUCH.longPressMs + 10);
    touch.up(1, at(10));
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('tap, then touch and hold: presses at the second touch, follows the finger, releases on lift', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(60));
    touch.down(1, 102, 100, at(20));
    at(DEFAULT_SCREEN_TOUCH.dragHoldMs);
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', 'DOWN', { x: 102, y: 100 });
    expect(touch.dragging).toBe(true);
    touch.move(1, 160, 120);
    expect(handlers.drag).toHaveBeenLastCalledWith({ x: 160, y: 120 });
    touch.up(1, at(40));
    expect(handlers.tap).toHaveBeenLastCalledWith('LEFT', 'UP', { x: 160, y: 120 });
    expect(touch.dragging).toBe(false);
    // O primeiro toque não virou clique: o arrasto o substitui.
    expect(handlers.tap.mock.calls.filter(([, action]) => action === 'CLICK')).toHaveLength(0);
  });

  it('tap, then touch and walk: the press happens as soon as the finger leaves the slop', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(60));
    touch.down(1, 100, 100, at(20));
    touch.move(1, 140, 100);
    expect(handlers.tap).toHaveBeenCalledWith('LEFT', 'DOWN', { x: 100, y: 100 });
    expect(handlers.drag).toHaveBeenCalledWith({ x: 140, y: 100 });
  });

  it('a drag started by walking cancels the hold timer: a quick double tap afterwards stays a double click', () => {
    const { handlers, touch, at } = setup();
    // Toque e segundo toque que anda logo: o arrasto começa pelo dedo, antes do tempo de segurar.
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(40));
    touch.down(1, 100, 100, at(20));
    touch.move(1, 140, 100);
    touch.up(1, at(30));
    expect(handlers.tap.mock.calls.map(([, action]) => action)).toEqual(['DOWN', 'UP']);
    handlers.tap.mockClear();
    // Um toque duplo rápido em seguida: o tempo de segurar do arrasto anterior não pode disparar no meio dele.
    touch.down(1, 300, 200, at(20));
    touch.up(1, at(40));
    touch.down(1, 300, 200, at(40));
    at(DEFAULT_SCREEN_TOUCH.dragHoldMs - 61);
    touch.up(1, at(20));
    at(DEFAULT_SCREEN_TOUCH.doubleTapMs + 50);
    expect(handlers.tap.mock.calls).toEqual([['LEFT', 'DOUBLE', { x: 300, y: 200 }]]);
  });

  it('a cancelled gesture in the middle of a drag releases the button', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(60));
    touch.down(1, 100, 100, at(20));
    touch.move(1, 150, 100);
    touch.move(1, 170, 110);
    touch.cancel();
    expect(handlers.tap).toHaveBeenLastCalledWith('LEFT', 'UP', { x: 170, y: 110 });
    expect(touch.active).toBe(false);
  });

  it('a second finger in the middle of a drag releases the button before turning into a pinch', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(60));
    touch.down(1, 100, 100, at(20));
    touch.move(1, 150, 100);
    touch.down(2, 200, 100, at(10));
    expect(handlers.tap).toHaveBeenLastCalledWith('LEFT', 'UP', { x: 150, y: 100 });
    expect(touch.dragging).toBe(false);
  });

  it('cancel drops a tap that was still waiting for its second touch', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 50, 50, at(0));
    touch.up(1, at(60));
    touch.cancel();
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('discardPending drops the waiting tap too (the screen changed under it)', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 50, 50, at(0));
    touch.up(1, at(60));
    touch.discardPending();
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('two fingers zoom the image and send no click', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.down(2, 140, 100, at(5));
    touch.move(2, 180, 100);
    expect(handlers.pinch).toHaveBeenCalledOnce();
    const [factor] = handlers.pinch.mock.calls[0];
    expect(factor).toBeCloseTo(2);
    touch.up(2, at(10));
    touch.up(1, at(10));
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.scroll).not.toHaveBeenCalled();
  });

  it('in scroll mode two fingers become wheel steps instead of zoom', () => {
    const { handlers, touch, at } = setup();
    touch.scrolling = true;
    touch.down(1, 100, 100, at(0));
    touch.down(2, 140, 100, at(5));
    touch.move(1, 100, 130);
    touch.move(2, 140, 130);
    expect(handlers.pinch).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();
    const sum = handlers.scroll.mock.calls.reduce((total, [, dy]) => total + dy, 0);
    expect(sum).toBeCloseTo(30);
  });

  it('after the pinch, the finger that stays does not become a tap or a drag', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.down(2, 140, 100, at(5));
    touch.up(2, at(20));
    touch.move(1, 300, 100);
    touch.up(1, at(20));
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.drag).not.toHaveBeenCalled();
  });

  it('a pinch right after a tap drops the tap that waited for its second touch', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.up(1, at(60));
    // Dentro da espera do toque duplo, dois dedos pousam e abrem a imagem.
    touch.down(1, 100, 100, at(40));
    touch.down(2, 140, 100, at(5));
    touch.move(2, 200, 100);
    touch.up(2, at(10));
    touch.up(1, at(10));
    at(1000);
    expect(handlers.pinch).toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.drag).not.toHaveBeenCalled();
  });

  it('two fingers moving together only pan the image: no click, no drag', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.down(2, 160, 100, at(5));
    touch.move(1, 60, 140);
    touch.move(2, 120, 140);
    touch.up(1, at(30));
    touch.up(2, at(5));
    at(1000);
    // A distância entre os dedos acaba igual: o zoom, somado, não muda.
    const zoom = handlers.pinch.mock.calls.reduce((total, [factor]) => total * factor, 1);
    expect(zoom).toBeCloseTo(1);
    const dx = handlers.pinch.mock.calls.reduce((total, [, , x]) => total + x, 0);
    const dy = handlers.pinch.mock.calls.reduce((total, [, , , y]) => total + y, 0);
    expect(dx).toBeCloseTo(-40);
    expect(dy).toBeCloseTo(40);
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.drag).not.toHaveBeenCalled();
  });

  it('a quick two-finger touch without moving is not a click', () => {
    const { handlers, touch, at } = setup();
    touch.down(1, 100, 100, at(0));
    touch.down(2, 160, 100, at(10));
    touch.up(1, at(40));
    touch.up(2, at(5));
    at(1000);
    expect(handlers.tap).not.toHaveBeenCalled();
  });
});
