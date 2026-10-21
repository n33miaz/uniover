import { DIALOG_EXIT_TIMEOUT_MS, leaveDialog } from './dialog-motion';

/** Animação de mentira: o que `leaveDialog` lê é só o fim (`finished`) e a contagem de repetições. */
function fakeAnimation(finished: Promise<unknown>, iterations = 1) {
  return {
    finished,
    effect: { getComputedTiming: () => ({ iterations }) },
  } as unknown as Animation;
}

describe('leaveDialog', () => {
  let dialog: HTMLDialogElement;

  beforeEach(() => {
    dialog = document.createElement('dialog');
    dialog.className = 'ui-dialog';
  });

  afterEach(() => vi.useRealTimers());

  it('finishes at once when nothing is animating (reduced motion, no transition)', () => {
    const done = vi.fn();
    leaveDialog(dialog, done);
    expect(dialog.classList.contains('closing')).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('waits for the transition to end before finishing, and only once', async () => {
    let end!: () => void;
    const finished = new Promise<void>((resolve) => (end = resolve));
    dialog.getAnimations = () => [fakeAnimation(finished)];
    const done = vi.fn();

    leaveDialog(dialog, done);
    leaveDialog(dialog, done); // um segundo pedido durante a saída não repete nada
    expect(done).not.toHaveBeenCalled();

    end();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('counts a cancelled transition as finished', async () => {
    dialog.getAnimations = () => [
      fakeAnimation(Promise.reject(new DOMException('', 'AbortError'))),
    ];
    const done = vi.fn();
    leaveDialog(dialog, done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('gives up waiting after the safety timeout', () => {
    vi.useFakeTimers();
    dialog.getAnimations = () => [fakeAnimation(new Promise(() => undefined))];
    const done = vi.fn();
    leaveDialog(dialog, done);

    vi.advanceTimersByTime(DIALOG_EXIT_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not wait for an animation that never ends (a spinner inside the sheet)', () => {
    dialog.getAnimations = () => [fakeAnimation(new Promise(() => undefined), Infinity)];
    const done = vi.fn();
    leaveDialog(dialog, done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
