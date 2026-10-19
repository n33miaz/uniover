import { HoldRepeater } from './hold-repeater';

describe('HoldRepeater', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the delay, then repeats at the interval', () => {
    const action = vi.fn();
    const repeater = new HoldRepeater(action, 400, 250);
    repeater.start();
    vi.advanceTimersByTime(399);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(action).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(action).toHaveBeenCalledTimes(6);
    repeater.stop();
  });

  it('repeats about four times per second', () => {
    const action = vi.fn();
    const repeater = new HoldRepeater(action, 400, 250);
    repeater.start();
    vi.advanceTimersByTime(400 + 4 * 250);
    expect(action).toHaveBeenCalledTimes(5);
    repeater.stop();
  });

  it('stops on release and never fires again', () => {
    const action = vi.fn();
    const repeater = new HoldRepeater(action, 400, 250);
    repeater.start();
    vi.advanceTimersByTime(700);
    expect(repeater.active).toBe(true);
    repeater.stop();
    expect(repeater.active).toBe(false);
    const calls = action.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(action).toHaveBeenCalledTimes(calls);
  });

  it('a short press never repeats', () => {
    const action = vi.fn();
    const repeater = new HoldRepeater(action, 400, 250);
    repeater.start();
    vi.advanceTimersByTime(300);
    repeater.stop();
    vi.advanceTimersByTime(5_000);
    expect(action).not.toHaveBeenCalled();
  });

  it('skips a round when asked to, without stopping the repetition', () => {
    const action = vi.fn();
    let busy = true;
    const repeater = new HoldRepeater(action, 400, 250, () => busy);
    repeater.start();
    vi.advanceTimersByTime(900);
    expect(action).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(250);
    expect(action).toHaveBeenCalledTimes(1);
    repeater.stop();
  });

  it('restarting resets the delay', () => {
    const action = vi.fn();
    const repeater = new HoldRepeater(action, 400, 250);
    repeater.start();
    vi.advanceTimersByTime(300);
    repeater.start();
    vi.advanceTimersByTime(300);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(action).toHaveBeenCalledTimes(1);
    repeater.stop();
  });
});
