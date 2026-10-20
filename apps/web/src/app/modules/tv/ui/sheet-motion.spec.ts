import { SHEET_EXIT_LIMIT_MS, leaveSheet } from './sheet-motion';

describe('leaveSheet', () => {
  let dialog: HTMLDialogElement;
  let done: ReturnType<typeof vi.fn<() => void>>;

  const withTransition = (duration: string) =>
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transitionDuration: duration,
    } as CSSStyleDeclaration);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dialog = document.createElement('dialog');
    document.body.appendChild(dialog);
    done = vi.fn<() => void>();
  });

  afterEach(() => {
    dialog.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls done at once when the CSS has no transition (and marks nothing)', () => {
    withTransition('0s');
    leaveSheet(dialog, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute('data-closing')).toBe(false);
  });

  it('calls done at once when the style cannot be read', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('no style');
    });
    leaveSheet(dialog, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('calls done at once for who asked for less motion, even with a transition in the CSS', () => {
    withTransition('0.2s');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    leaveSheet(dialog, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it.each(['0.2s', '200ms', '0s, 0.15s'])(
    'with a transition of %s it marks the sheet and waits for its end',
    (duration) => {
      withTransition(duration);
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      leaveSheet(dialog, done);
      expect(dialog.hasAttribute('data-closing')).toBe(true);
      expect(done).not.toHaveBeenCalled();
      dialog.dispatchEvent(new Event('transitionend'));
      expect(done).toHaveBeenCalledTimes(1);
    },
  );

  it('gives up waiting after the safety limit, and only once', () => {
    withTransition('0.2s');
    leaveSheet(dialog, done);
    vi.advanceTimersByTime(SHEET_EXIT_LIMIT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
    dialog.dispatchEvent(new Event('transitionend'));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a second call while the first is leaving does nothing', () => {
    withTransition('0.2s');
    leaveSheet(dialog, done);
    leaveSheet(dialog, done);
    dialog.dispatchEvent(new Event('transitionend'));
    expect(done).toHaveBeenCalledTimes(1);
  });
});
