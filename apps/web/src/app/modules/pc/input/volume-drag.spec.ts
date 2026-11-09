import {
  MAX_PENDING_STEPS,
  MAX_STEPS_PER_REQUEST,
  PX_PER_VOLUME_STEP,
  VolumeDrag,
} from './volume-drag';

describe('VolumeDrag', () => {
  it('sends nothing before the finger has gone one step', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP - 1);
    expect(drag.waiting).toBe(false);
    expect(drag.take()).toBeNull();
  });

  it('turns the distance into steps and keeps the fraction of a step for the next move', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP * 2.5);
    expect(drag.take()).toEqual({ direction: 'UP', steps: 2 });
    drag.move(PX_PER_VOLUME_STEP * 0.5);
    expect(drag.take()).toEqual({ direction: 'UP', steps: 1 });
    expect(drag.take()).toBeNull();
  });

  it('going left lowers the volume', () => {
    const drag = new VolumeDrag();
    drag.move(-PX_PER_VOLUME_STEP * 3);
    expect(drag.take()).toEqual({ direction: 'DOWN', steps: 3 });
  });

  it('going and coming back before the request leaves cancels out', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP * 4);
    drag.move(-PX_PER_VOLUME_STEP * 4);
    expect(drag.take()).toBeNull();
  });

  it('never asks for more steps than the contract allows in one request', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP * 25);
    expect(drag.take()).toEqual({ direction: 'UP', steps: MAX_STEPS_PER_REQUEST });
    expect(drag.take()).toEqual({ direction: 'UP', steps: MAX_STEPS_PER_REQUEST });
    expect(drag.take()).toEqual({ direction: 'UP', steps: 5 });
    expect(drag.take()).toBeNull();
  });

  it('does not run after the finger for more than one whole scale when the network is slow', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP * 500);
    let total = 0;
    for (let request = drag.take(); request; request = drag.take()) total += request.steps;
    expect(total).toBe(MAX_PENDING_STEPS);
  });

  it('reset forgets the steps waiting and the fraction of a pixel', () => {
    const drag = new VolumeDrag();
    drag.move(PX_PER_VOLUME_STEP * 3 + 4);
    drag.reset();
    expect(drag.take()).toBeNull();
    drag.move(PX_PER_VOLUME_STEP - 4);
    expect(drag.take()).toBeNull();
  });

  it('ignores a move that is not a number', () => {
    const drag = new VolumeDrag();
    drag.move(Number.NaN);
    drag.move(Number.POSITIVE_INFINITY);
    expect(drag.take()).toBeNull();
  });
});
