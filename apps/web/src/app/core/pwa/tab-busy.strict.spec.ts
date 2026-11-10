import {
  OTHER_TABS_STRICT_TIMEOUT_MS,
  answerTabBusyQueries,
  askOtherTabs,
  askOtherTabsStrict,
} from './tab-busy';
import { FakeBroadcastChannel, installFakeBroadcastChannel } from './tab-busy-test-kit';

describe('the strict question of an automatic swap', () => {
  let restore: () => void;
  const stops: (() => void)[] = [];

  beforeEach(() => {
    restore = installFakeBroadcastChannel();
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is not busy when there is no other tab to ask', async () => {
    expect(await askOtherTabsStrict(window, 0, 500, 'tab-a')).toBe(false);
  });

  it('needs every other tab to say it is free, and returns as soon as the last one does', async () => {
    stops.push(answerTabBusyQueries(window, () => false, 'tab-b'));
    stops.push(answerTabBusyQueries(window, () => false, 'tab-c'));
    expect(await askOtherTabsStrict(window, 2, 500, 'tab-a')).toBe(false);
  });

  it('tells the other tab that the question is strict, so it counts a session that never asks for confirmation', async () => {
    const isBusy = vi.fn().mockImplementation((strict: boolean) => strict);
    stops.push(answerTabBusyQueries(window, isBusy, 'tab-b'));

    expect(await askOtherTabsStrict(window, 1, 500, 'tab-a')).toBe(true);
    expect(isBusy).toHaveBeenLastCalledWith(true);
  });

  it('counts the silence of a tab as busy: a frozen tab may have a session open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stops.push(answerTabBusyQueries(window, () => false, 'tab-b'));
    // Duas outras abas abertas, só uma responde: a outra (congelada, ou de versão que não responde assim) vale como ocupada.
    const asked = askOtherTabsStrict(window, 2, OTHER_TABS_STRICT_TIMEOUT_MS, 'tab-a');
    await vi.advanceTimersByTimeAsync(OTHER_TABS_STRICT_TIMEOUT_MS);
    expect(await asked).toBe(true);
  });

  it('counts a tab of an older version, which only ever answers "busy", as busy when it stays silent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = new FakeBroadcastChannel('uniover.tab-busy');
    const asked = askOtherTabsStrict(window, 1, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(true);
    old.close();
  });

  it('counts the same tab answering twice only once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const other = new FakeBroadcastChannel('uniover.tab-busy');
    other.onmessage = (event) => {
      const { id } = event.data as { id: string };
      other.postMessage({ type: 'idle', id, from: 'tab-b' });
      other.postMessage({ type: 'idle', id, from: 'tab-b' });
    };
    const asked = askOtherTabsStrict(window, 2, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(true);
    other.close();
  });

  it('is busy without BroadcastChannel, since nothing can confirm the other tabs', async () => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
    expect(await askOtherTabsStrict(window, 1, 500, 'tab-a')).toBe(true);
    // Sem outras abas não há o que confirmar.
    expect(await askOtherTabsStrict(window, 0, 500, 'tab-a')).toBe(false);
  });

  it('is busy when the question cannot even be sent', async () => {
    vi.spyOn(FakeBroadcastChannel.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('fechado');
    });
    expect(await askOtherTabsStrict(window, 1, 500, 'tab-a')).toBe(true);
  });

  it('keeps the tap question as it was: silence is free, and the answer is only the busy one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const isBusy = vi.fn().mockImplementation((strict: boolean) => strict);
    stops.push(answerTabBusyQueries(window, isBusy, 'tab-b'));

    const asked = askOtherTabs(window, 500, 'tab-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await asked).toBe(false);
    expect(isBusy).toHaveBeenLastCalledWith(false);
  });
});
