import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { illustrationFor } from './illustration-map';
import { IllustrationPrefetcher } from './illustration-prefetcher';

const WITH_ART = 'supino-reto-com-barra';
const ALSO_WITH_ART = 'agachamento-livre-com-barra';

describe('IllustrationPrefetcher', () => {
  const online = signal(true);
  let fetchMock: ReturnType<typeof vi.fn>;

  function prefetcher() {
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectivityService, useValue: { online } }],
    });
    return TestBed.inject(IllustrationPrefetcher);
  }

  function setSaveData(value: boolean | undefined) {
    Object.defineProperty(navigator, 'connection', {
      value: value === undefined ? undefined : { saveData: value },
      configurable: true,
    });
  }

  beforeEach(() => {
    online.set(true);
    setSaveData(undefined);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'connection');
  });

  const urls = () => fetchMock.mock.calls.map(([url]) => url as string);

  it('fetches both poses of each exercise from the same origin and counts the files', async () => {
    const count = await prefetcher().warm([WITH_ART, ALSO_WITH_ART]);
    const expected = [WITH_ART, ALSO_WITH_ART].flatMap((slug) =>
      illustrationFor(slug)!.frames.map((file) => `/exercise-art/${file}`),
    );
    expect(urls()).toEqual(expected);
    expect(count).toBe(4);
  });

  it('skips exercises without an illustration and repeated ones', async () => {
    const count = await prefetcher().warm(['exercicio-sem-arte', WITH_ART, WITH_ART]);
    expect(urls()).toHaveLength(2);
    expect(count).toBe(2);
  });

  it('fetches one file at a time, never in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true };
    });
    await prefetcher().warm([WITH_ART, ALSO_WITH_ART]);
    expect(peak).toBe(1);
  });

  it('does nothing without a network', async () => {
    online.set(false);
    expect(await prefetcher().warm([WITH_ART])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the data saver is on', async () => {
    setSaveData(true);
    expect(await prefetcher().warm([WITH_ART])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works when the browser does not expose the data saver', async () => {
    setSaveData(false);
    expect(await prefetcher().warm([WITH_ART])).toBe(2);
  });

  it('stops at the first network failure and does not retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockRejectedValue(new TypeError('network'));
    const count = await prefetcher().warm([WITH_ART, ALSO_WITH_ART]);
    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips a file the server refused and goes on', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const count = await prefetcher().warm([WITH_ART]);
    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns zero for an empty list', async () => {
    expect(await prefetcher().warm([])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
