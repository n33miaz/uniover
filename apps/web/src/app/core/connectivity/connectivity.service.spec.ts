import { TestBed } from '@angular/core/testing';
import { ConnectivityService, CONNECTIVITY_CONFIG } from './connectivity.service';

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

  it('a failed request with network starts waking, counts seconds and polls every 3 s', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
    expect(service.serverState()).toBe('waking');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(service.waitedSeconds()).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/health/live', { cache: 'no-store' });
  });

  it('returns to ok when the health check answers', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
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
          useValue: { pollMs: 3_000, windowMs: 10_000, healthUrl: '/health/live' },
        },
      ],
    });
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.serverState()).toBe('offline');
    expect(service.windowExpired()).toBe(true);
    // Uma nova falha reinicia a espera.
    service.reportRequestFailure();
    expect(service.serverState()).toBe('waking');
    expect(service.windowExpired()).toBe(false);
  });

  it('losing the network while waking drops the curtain', () => {
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
    window.dispatchEvent(new Event('offline'));
    expect(service.serverState()).toBe('offline');
  });

  it('a successful request clears the waking state', () => {
    const service = TestBed.inject(ConnectivityService);
    service.reportRequestFailure();
    service.reportRequestSuccess();
    expect(service.serverState()).toBe('ok');
  });
});
