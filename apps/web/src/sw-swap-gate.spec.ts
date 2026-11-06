import { type AskTab, swapIfSafe } from './sw-swap-gate';

describe('swapIfSafe', () => {
  const free: AskTab = async () => false;
  const busy: AskTab = async () => true;
  const silent: AskTab = async () => undefined;
  const broken: AskTab = () => Promise.reject(new Error('aba sumiu'));

  it('swaps only when every tab answers that it is free', async () => {
    const skip = vi.fn().mockResolvedValue(undefined);
    expect(await swapIfSafe([free, free, free], skip)).toBe('swapped');
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another tab has unsaved work', [free, busy]],
    ['a tab does not answer in time', [free, silent]],
    ['asking a tab fails', [free, broken]],
  ])('does not swap when %s (a missing answer counts as busy)', async (_name, tabs) => {
    const skip = vi.fn().mockResolvedValue(undefined);
    expect(await swapIfSafe(tabs, skip)).toBe('busy');
    expect(skip).not.toHaveBeenCalled();
  });

  it('does not swap when there is no tab to ask', async () => {
    const skip = vi.fn().mockResolvedValue(undefined);
    expect(await swapIfSafe([], skip)).toBe('busy');
    expect(skip).not.toHaveBeenCalled();
  });

  it('asks all the tabs together, not one after the other', async () => {
    const order: string[] = [];
    const slow =
      (name: string): AskTab =>
      async () => {
        order.push(`ask ${name}`);
        await Promise.resolve();
        order.push(`answer ${name}`);
        return false;
      };
    await swapIfSafe([slow('a'), slow('b')], async () => undefined);
    expect(order).toEqual(['ask a', 'ask b', 'answer a', 'answer b']);
  });
});
