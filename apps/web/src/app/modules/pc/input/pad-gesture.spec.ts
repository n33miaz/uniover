import { PadGesture, PadHandlers } from './pad-gesture';

function setup() {
  const handlers = {
    move: vi.fn<PadHandlers['move']>(),
    scroll: vi.fn<PadHandlers['scroll']>(),
    tap: vi.fn<PadHandlers['tap']>(),
  };
  return { handlers, gesture: new PadGesture(handlers) };
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
    expect(handlers.scroll).toHaveBeenLastCalledWith(0, 20);
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
});
