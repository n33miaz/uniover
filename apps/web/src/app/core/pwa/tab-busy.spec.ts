import { answerTabBusyQueries, askOtherTabs } from './tab-busy';
import { FakeBroadcastChannel, installFakeBroadcastChannel } from './tab-busy-test-kit';

describe('tab busy queries', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeBroadcastChannel();
  });

  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it('answers yes when another tab asks and this one has unsaved work', async () => {
    const stop = answerTabBusyQueries(window, () => true, 'tab-b');
    expect(await askOtherTabs(window, 500, 'tab-a')).toBe(true);
    stop();
  });

  it('says nothing when this tab is clean: the asker waits out the timeout and treats it as clean', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = answerTabBusyQueries(window, () => false, 'tab-b');
    const asked = askOtherTabs(window, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(false);
    stop();
  });

  it('treats a tab that does not answer in time (frozen in the background) as clean', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asked = askOtherTabs(window, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void asked.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await asked).toBe(false);
  });

  it('never counts the tab that is asking, even though the channel also delivers inside the same tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = answerTabBusyQueries(window, () => true, 'tab-a');
    const asked = askOtherTabs(window, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(false);
    stop();
  });

  it('ignores an answer meant for another question', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const other = new FakeBroadcastChannel('uniover.tab-busy');
    const asked = askOtherTabs(window, 500, 'tab-a');
    other.postMessage({ type: 'busy', id: 'outra-pergunta', from: 'tab-b' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(false);
    other.close();
  });

  it('closes the channel it opened once it has an answer, so nothing leaks', async () => {
    const stop = answerTabBusyQueries(window, () => true, 'tab-b');
    const before = FakeBroadcastChannel.openCount();
    await askOtherTabs(window, 500, 'tab-a');
    expect(FakeBroadcastChannel.openCount()).toBe(before);
    stop();
    expect(FakeBroadcastChannel.openCount()).toBe(before - 1);
  });

  it('answers false and stays inert in a browser without BroadcastChannel', async () => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
    expect(await askOtherTabs(window, 500, 'tab-a')).toBe(false);
    expect(() => answerTabBusyQueries(window, () => true, 'tab-b')()).not.toThrow();
  });
});
