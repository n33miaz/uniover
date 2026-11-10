import { TestBed } from '@angular/core/testing';
import { ConnectivityService, CONNECTIVITY_CONFIG } from './connectivity.service';
import { ResumeGrace } from './resume-grace';

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

describe('ConnectivityService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnline(true);
    fetchMock = vi.fn().mockRejectedValue(new Error('fora do ar'));
    vi.stubGlobal('fetch', fetchMock);
    // jsdom lê fetch de window; garante que o serviço enxerga o mock.
    window.fetch = fetchMock as unknown as typeof window.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Duas falhas seguidas: o limite que dispensa a checagem e mostra "acordando" na hora. */
  function failTwice(service: ConnectivityService) {
    service.reportRequestFailure();
    service.reportRequestFailure();
  }

  it('starts ok when the browser is online and offline otherwise', () => {
    expect(TestBed.inject(ConnectivityService).serverState()).toBe('ok');
    TestBed.resetTestingModule();
    setOnline(false);
    expect(TestBed.inject(ConnectivityService).serverState()).toBe('offline');
  });

  it('follows the online and offline events', () => {
    const service = TestBed.inject(ConnectivityService);
    window.dispatchEvent(new Event('offline'));
    expect(service.online()).toBe(false);
    expect(service.serverState()).toBe('offline');
    window.dispatchEvent(new Event('online'));
    expect(service.online()).toBe(true);
    expect(service.serverState()).toBe('ok');
  });

  it('a failed request without network is offline, never "waking"', () => {
    setOnline(false);
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
    expect(service.serverState()).toBe('offline');
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('outside the grace period', () => {
    it('a single failure shows nothing and only triggers one health check', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      expect(service.serverState()).toBe('ok');
      expect(service.quiet()).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/health/live');
      expect(service.serverState()).toBe('ok');
      expect(service.quiet()).toBe(false);
    });

    it('a single failure becomes "waking" when the health check fails', async () => {
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(10);
      expect(service.serverState()).toBe('waking');
    });

    it('cuts a health check that never answers (the sleeping server holds the request open)', async () => {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('abortado')));
          }),
      );
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(service.serverState()).toBe('ok');
      await vi.advanceTimersByTimeAsync(600);
      expect(service.serverState()).toBe('waking');
    });

    it('a response that arrives while the check is running cancels the verdict', async () => {
      let answer!: (value: { ok: boolean }) => void;
      fetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      service.reportRequestSuccess();
      answer({ ok: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(service.serverState()).toBe('ok');
    });

    it('two failures in a row show "waking" without waiting for the check', () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      expect(service.serverState()).toBe('waking');
    });

    it('a response in between resets the count of failures', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      service.reportRequestSuccess();
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(10);
      expect(service.serverState()).toBe('ok');
    });

    it('counts seconds and polls every 3 s while waking', async () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      expect(service.serverState()).toBe('waking');
      fetchMock.mockClear();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(service.waitedSeconds()).toBe(7);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        '/health/live',
        expect.objectContaining({ cache: 'no-store' }),
      );
    });

    it('a poll that never answers is cut like the first check, so the next rounds still go out', async () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      fetchMock.mockClear();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('abortado')));
          }),
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Preso por 2,5 s e cortado: a rodada seguinte (a cada 3 s) não é engolida por "já há uma em andamento".
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(service.serverState()).toBe('waking');

      fetchMock.mockResolvedValue({ ok: true });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(service.serverState()).toBe('ok');
    });

    it('a late answer from an earlier waiting never overwrites a newer state', async () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      fetchMock.mockClear();
      let answerLate!: (value: { ok: boolean }) => void;
      fetchMock.mockReturnValueOnce(new Promise((resolve) => (answerLate = resolve)));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // O servidor respondeu a uma requisição (a espera acaba) e logo depois caiu de novo (outra espera começa).
      service.reportRequestSuccess();
      expect(service.serverState()).toBe('ok');
      failTwice(service);
      expect(service.serverState()).toBe('waking');

      answerLate({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.serverState()).toBe('waking');
    });

    it('returns to ok when the health check answers', async () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      fetchMock.mockResolvedValue({ ok: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(service.serverState()).toBe('ok');
      fetchMock.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('gives up after the window and reports that the server did not answer', async () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: CONNECTIVITY_CONFIG,
            useValue: {
              pollMs: 3_000,
              windowMs: 10_000,
              healthUrl: '/health/live',
              probeTimeoutMs: 2_500,
              failuresToWake: 2,
            },
          },
        ],
      });
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(service.serverState()).toBe('offline');
      expect(service.windowExpired()).toBe(true);
      // Novas falhas reiniciam a espera.
      failTwice(service);
      expect(service.serverState()).toBe('waking');
      expect(service.windowExpired()).toBe(false);
    });

    it('losing the network while waking drops the curtain', () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      expect(service.serverState()).toBe('waking');
      window.dispatchEvent(new Event('offline'));
      expect(service.serverState()).toBe('offline');
    });

    it('a successful request clears the waking state', () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      service.reportRequestSuccess();
      expect(service.serverState()).toBe('ok');
    });
  });

  describe('right after coming back to the app', () => {
    it('is quiet during the grace period and stops being quiet when it ends', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      expect(service.quiet()).toBe(true);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(service.quiet()).toBe(false);
    });

    it('failures during the grace period show nothing, even many of them, and no check goes out', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      for (let i = 0; i < 6; i++) service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(3_900);
      expect(service.serverState()).toBe('ok');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('at the end of the grace period one check decides: healthy server, nothing shown', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      service.reportRequestFailure();
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(4_100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.serverState()).toBe('ok');
    });

    it('at the end of the grace period one check decides: dead server, "waking" starts', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(4_100);
      expect(service.serverState()).toBe('waking');
    });

    it('with no failure during the grace period the end does not check anything', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.serverState()).toBe('ok');
    });

    it('a transient "offline" from the browser waits for the grace period and is dropped if it was nothing', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      window.dispatchEvent(new Event('offline'));
      expect(service.online()).toBe(true);
      expect(service.serverState()).toBe('ok');
      await vi.advanceTimersByTimeAsync(4_100);
      // O navegador (mock) segue dizendo que está online: o "offline" era ruído.
      expect(service.online()).toBe(true);
      expect(service.serverState()).toBe('ok');
    });

    it('an "offline" that the browser keeps saying after the grace period is applied then', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(service.serverState()).toBe('ok');
      await vi.advanceTimersByTimeAsync(4_100);
      expect(service.online()).toBe(false);
      expect(service.serverState()).toBe('offline');
    });

    it('an "online" event during the grace period cancels the deferred "offline"', async () => {
      const service = TestBed.inject(ConnectivityService);
      TestBed.inject(ResumeGrace).begin();
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
      setOnline(false);
      await vi.advanceTimersByTimeAsync(4_100);
      expect(service.serverState()).toBe('ok');
    });

    it('the grace period forgets the failures counted before it', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const service = TestBed.inject(ConnectivityService);
      service.reportRequestFailure();
      await vi.advanceTimersByTimeAsync(10);
      TestBed.inject(ResumeGrace).begin();
      fetchMock.mockClear();
      await vi.advanceTimersByTimeAsync(4_100);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('coming back while "waking" looks at the server right away', async () => {
      const service = TestBed.inject(ConnectivityService);
      failTwice(service);
      fetchMock.mockClear();
      fetchMock.mockResolvedValue({ ok: true });
      TestBed.inject(ResumeGrace).begin();
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.serverState()).toBe('ok');
    });

    it('the "offline" shown while away goes away when the browser says it is back', () => {
      const service = TestBed.inject(ConnectivityService);
      window.dispatchEvent(new Event('offline'));
      expect(service.serverState()).toBe('offline');
      TestBed.inject(ResumeGrace).begin();
      // O mock do navegador diz que há rede: a volta já tira a faixa, sem esperar o evento `online`.
      expect(service.online()).toBe(true);
      expect(service.serverState()).toBe('ok');
    });
  });
});
