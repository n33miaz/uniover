import { DEFAULT_PAD_GESTURE, PadGesture, THREE_FINGER_SWIPE_PX } from './pad-gesture';
import { fakeTimers, setup } from './pad-gesture-test-kit';

const HOME = [
  { id: 1, x: 150 },
  { id: 2, x: 200 },
  { id: 3, x: 250 },
];

/** Três dedos pousados lado a lado, o centro em (200, 200). */
function land(gesture: PadGesture, at = 0) {
  HOME.forEach(({ id, x }, index) => gesture.down(id, x, 200, at + index * 5));
}

/** Os três dedos andando juntos até `(dx, dy)` do ponto onde pousaram. */
function slide(gesture: PadGesture, dx: number, dy: number, at: number) {
  HOME.forEach(({ id, x }) => gesture.move(id, x + dx, 200 + dy, at));
}

function release(gesture: PadGesture, at: number) {
  HOME.forEach(({ id }, index) => gesture.up(id, at + index * 5));
}

function on() {
  const made = setup();
  made.gesture.configure({ threeFingerGestures: true });
  return made;
}

describe('PadGesture: three-finger gestures', () => {
  it('start switched off, as the owner asked', () => {
    expect(DEFAULT_PAD_GESTURE.threeFingerGestures).toBe(false);
  });

  it('switched off, three fingers behave exactly as before: they scroll, and a tap is the middle click', () => {
    const { gesture, handlers } = setup();
    land(gesture);
    slide(gesture, 0, -30, 40);
    slide(gesture, 0, -90, 80);
    release(gesture, 120);
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
    expect(handlers.scroll).toHaveBeenCalled();

    const tapped = setup();
    land(tapped.gesture);
    release(tapped.gesture, 100);
    expect(tapped.handlers.tap).toHaveBeenCalledExactlyOnceWith('MIDDLE', expect.anything());
    expect(tapped.handlers.threeFingerSwipe).not.toHaveBeenCalled();
  });

  it('switched off, the very same gesture ends the same with or without a swipe receiver', () => {
    const log = (withReceiver: boolean) => {
      const made = setup();
      const handlers = withReceiver
        ? made.handlers
        : { ...made.handlers, threeFingerSwipe: undefined };
      const gesture = new PadGesture(handlers, DEFAULT_PAD_GESTURE, fakeTimers().timers);
      land(gesture);
      slide(gesture, 20, -70, 40);
      slide(gesture, 40, -140, 80);
      release(gesture, 120);
      return [
        made.handlers.scroll.mock.calls,
        made.handlers.tap.mock.calls,
        made.handlers.move.mock.calls,
        made.handlers.scrollEnd.mock.calls,
      ];
    };
    expect(log(true)).toEqual(log(false));
  });

  it.each([
    ['right', THREE_FINGER_SWIPE_PX + 20, 0],
    ['left', -(THREE_FINGER_SWIPE_PX + 20), 0],
    ['up', 0, -(THREE_FINGER_SWIPE_PX + 20)],
    ['down', 0, THREE_FINGER_SWIPE_PX + 20],
  ] as const)('three fingers sliding %s swipe once, in that direction', (direction, dx, dy) => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, dx / 2, dy / 2, 30);
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
    slide(gesture, dx, dy, 60);
    slide(gesture, dx * 2, dy * 2, 90);
    release(gesture, 130);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledExactlyOnceWith(direction);
  });

  it('the direction that dominates wins on a diagonal', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, 80, -50, 60);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledExactlyOnceWith('right');
  });

  it('a swipe is never a scroll, a click, a move or a glide', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, 0, THREE_FINGER_SWIPE_PX + 30, 40);
    slide(gesture, 0, THREE_FINGER_SWIPE_PX + 120, 80);
    release(gesture, 100); // rápido, abaixo do tempo de um toque
    expect(handlers.threeFingerSwipe).toHaveBeenCalledTimes(1);
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.scrollEnd).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.dragStart).not.toHaveBeenCalled();
  });

  it('moving less than the threshold does nothing, and it is not the middle click either', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, 0, THREE_FINGER_SWIPE_PX - 10, 40);
    release(gesture, 80);
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.tap).not.toHaveBeenCalled();
  });

  it('a quick tap with three fingers is still the middle click', () => {
    const { gesture, handlers } = on();
    land(gesture);
    release(gesture, 100);
    expect(handlers.tap).toHaveBeenCalledExactlyOnceWith('MIDDLE', expect.anything());
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
  });

  it('only one swipe per gesture; a new one needs every finger to leave first', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, THREE_FINGER_SWIPE_PX + 20, 0, 40);
    slide(gesture, -(THREE_FINGER_SWIPE_PX + 20), 0, 80);
    slide(gesture, 0, THREE_FINGER_SWIPE_PX + 90, 120);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledTimes(1);
    release(gesture, 200);

    land(gesture, 400);
    slide(gesture, 0, -(THREE_FINGER_SWIPE_PX + 20), 440);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledTimes(2);
    expect(handlers.threeFingerSwipe).toHaveBeenLastCalledWith('up');
  });

  it('the fingers that are left after one lifts do not scroll or move the pointer', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, 0, 20, 30);
    gesture.up(3, 40);
    gesture.move(1, 150, 260, 60);
    gesture.move(2, 200, 280, 80);
    gesture.up(1, 100);
    gesture.up(2, 105);
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
  });

  it('a finger that leaves first does not look like a swipe, even though the center of the rest jumps', () => {
    const { gesture, handlers } = on();
    const spread = THREE_FINGER_SWIPE_PX * 3;
    gesture.down(1, 200 - spread, 200, 0);
    gesture.down(2, 200, 200, 5);
    gesture.down(3, 200 + spread, 200, 10);
    // Sai o dedo da esquerda: o centro dos que ficam pula metade do afastamento (mais que o limiar do deslize), sem que
    // nenhum dedo tenha andado.
    gesture.up(1, 40);
    gesture.move(2, 201, 200, 50);
    gesture.move(3, 201 + spread, 200, 50);
    gesture.up(2, 80);
    gesture.up(3, 82);
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
    expect(handlers.scroll).not.toHaveBeenCalled();
    expect(handlers.move).not.toHaveBeenCalled();
  });

  it('a finger that leaves first, with the two others still on the pad, never swipes on their next small move', () => {
    const { gesture, handlers } = on();
    const spread = THREE_FINGER_SWIPE_PX * 3;
    gesture.down(1, 200, 200 - spread, 0);
    gesture.down(2, 200, 200, 5);
    gesture.down(3, 200, 200 + spread, 10);
    gesture.up(3, 30);
    for (let step = 1; step <= 4; step++) {
      gesture.move(1, 200, 200 - spread + step, 30 + step * 10);
      gesture.move(2, 200, 200 + step, 30 + step * 10);
    }
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
  });

  it('the distance counts from where the third finger landed, not from the first', () => {
    const { gesture, handlers } = on();
    gesture.down(1, 150, 200, 0);
    gesture.down(2, 200, 200, 5);
    // os dois dedos andaram antes de o terceiro pousar: nada disso conta para o deslize
    gesture.move(1, 150, 120, 20);
    gesture.move(2, 200, 120, 20);
    gesture.down(3, 250, 120, 30);
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();
    gesture.move(1, 150, 120 + THREE_FINGER_SWIPE_PX, 60);
    gesture.move(2, 200, 120 + THREE_FINGER_SWIPE_PX, 60);
    gesture.move(3, 250, 120 + THREE_FINGER_SWIPE_PX, 60);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledExactlyOnceWith('down');
  });

  it('two fingers still scroll and still right click with the gestures on', () => {
    const { gesture, handlers } = on();
    gesture.down(1, 150, 200, 0);
    gesture.down(2, 250, 200, 5);
    gesture.move(1, 150, 140, 30);
    gesture.move(2, 250, 140, 30);
    gesture.up(1, 60);
    gesture.up(2, 65);
    expect(handlers.scroll).toHaveBeenCalled();
    expect(handlers.threeFingerSwipe).not.toHaveBeenCalled();

    const tapped = on();
    tapped.gesture.down(1, 150, 200, 0);
    tapped.gesture.down(2, 250, 200, 5);
    tapped.gesture.up(1, 80);
    tapped.gesture.up(2, 85);
    expect(tapped.handlers.tap).toHaveBeenCalledExactlyOnceWith('RIGHT', expect.anything());
  });

  it('without a receiver for the swipe, the gestures on change nothing', () => {
    const made = setup();
    const gesture = new PadGesture(
      { ...made.handlers, threeFingerSwipe: undefined },
      { ...DEFAULT_PAD_GESTURE, threeFingerGestures: true },
      fakeTimers().timers,
    );
    land(gesture);
    slide(gesture, 0, -120, 60);
    release(gesture, 100);
    expect(made.handlers.scroll).toHaveBeenCalled();
  });

  it('cancelling the gesture lets the next one swipe again', () => {
    const { gesture, handlers } = on();
    land(gesture);
    slide(gesture, THREE_FINGER_SWIPE_PX + 20, 0, 40);
    gesture.cancel();
    land(gesture, 300);
    slide(gesture, THREE_FINGER_SWIPE_PX + 20, 0, 340);
    expect(handlers.threeFingerSwipe).toHaveBeenCalledTimes(2);
  });
});
