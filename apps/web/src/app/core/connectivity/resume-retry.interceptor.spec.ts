import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { connectivityInterceptor } from './connectivity.interceptor';
import { ConnectivityService } from './connectivity.service';
import { ResumeGrace } from './resume-grace';
import { resumeRetryInterceptor } from './resume-retry.interceptor';

describe('resumeRetryInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let connectivity: ConnectivityService;
  let grace: ResumeGrace;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    window.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof window.fetch;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([connectivityInterceptor, resumeRetryInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    connectivity = TestBed.inject(ConnectivityService);
    grace = TestBed.inject(ResumeGrace);
    vi.spyOn(connectivity, 'reportRequestFailure');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const noResponse = () => ({ status: 0, statusText: '' });

  it('retries a GET that fails with no response during the grace period, and the caller only sees the success', async () => {
    grace.begin();
    const next = vi.fn();
    const error = vi.fn();
    http.get('/api/x').subscribe({ next, error });
    backend.expectOne('/api/x').error(new ProgressEvent('error'), noResponse());
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    backend.expectOne('/api/x').flush({ ok: 1 });
    expect(next).toHaveBeenCalledWith({ ok: 1 });
    expect(error).not.toHaveBeenCalled();
    // A falha salva pela repetição nunca chega à conectividade.
    expect(connectivity.reportRequestFailure).not.toHaveBeenCalled();
  });

  it('gives up after the configured retries and then reports the failure', async () => {
    grace.begin();
    const error = vi.fn();
    http.get('/api/x').subscribe({ error });
    for (let attempt = 0; attempt < 3; attempt++) {
      backend.expectOne('/api/x').error(new ProgressEvent('error'), noResponse());
      await vi.advanceTimersByTimeAsync(900);
    }
    backend.verify();
    expect(error).toHaveBeenCalledTimes(1);
    expect(connectivity.reportRequestFailure).toHaveBeenCalledTimes(1);
  });

  it('does not retry a GET outside the grace period', () => {
    const error = vi.fn();
    http.get('/api/x').subscribe({ error });
    backend.expectOne('/api/x').error(new ProgressEvent('error'), noResponse());
    backend.verify();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('never retries a command: a second tap on the TV or the PC would act twice', () => {
    grace.begin();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const error = vi.fn();
      http.request(method, '/api/cmd', { body: {} }).subscribe({ error });
      backend.expectOne('/api/cmd').error(new ProgressEvent('error'), noResponse());
      backend.verify();
      expect(error).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry a real answer from the server, even during the grace period', () => {
    grace.begin();
    const error = vi.fn();
    http.get('/api/x').subscribe({ error });
    backend.expectOne('/api/x').flush('x', { status: 503, statusText: 'fora' });
    backend.verify();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
