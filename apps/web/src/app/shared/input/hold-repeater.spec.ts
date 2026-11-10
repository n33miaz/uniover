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

  describe('when the page leaves the screen', () => {
    const hide = () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    afterEach(() => Reflect.deleteProperty(document, 'visibilityState'));

    it('stops a running repetition when the page goes to the background, and nothing fires after the return', () => {
      const action = vi.fn();
      const repeater = new HoldRepeater(action, 400, 250);
      repeater.start();
      vi.advanceTimersByTime(700);
      expect(action).toHaveBeenCalledTimes(2);
      hide();
      expect(repeater.active).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(action).toHaveBeenCalledTimes(2);
    });

    it('also stops before the first repetition, and on pagehide', () => {
      const action = vi.fn();
      const repeater = new HoldRepeater(action, 400, 250);
      repeater.start();
      hide();
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();

      repeater.start();
      vi.advanceTimersByTime(500);
      window.dispatchEvent(new Event('pagehide'));
      expect(repeater.active).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('a page that only became visible again does not stop anything', () => {
      const action = vi.fn();
      const repeater = new HoldRepeater(action, 400, 250);
      repeater.start();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(repeater.active).toBe(true);
      repeater.stop();
    });

    it('leaves no listener behind once stopped', () => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      const repeater = new HoldRepeater(vi.fn(), 400, 250);
      repeater.start();
      repeater.stop();
      repeater.stop();
      const added = add.mock.calls.filter(([type]) => type === 'visibilitychange').length;
      const removed = remove.mock.calls.filter(([type]) => type === 'visibilitychange').length;
      expect(added).toBe(1);
      expect(removed).toBe(1);
      add.mockRestore();
      remove.mockRestore();
    });
  });
});
