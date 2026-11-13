import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { APP_CONFIG } from '../config/app-config';
import { DIRECT_USAGE_FLUSH_MS, DIRECT_USAGE_MAX_SECONDS, DirectUsage } from './direct-usage';

describe('DirectUsage', () => {
  const url = (session: string) => `${APP_CONFIG.apiBase}/v1/pc/rtc/${session}/usage`;

  function setup() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    return { usage: TestBed.inject(DirectUsage), http: TestBed.inject(HttpTestingController) };
  }

  afterEach(() => vi.useRealTimers());

  it('counts seconds with input, not messages, and reports them a minute later', () => {
    vi.useFakeTimers();
    const { usage, http } = setup();
    const start = 1_700_000_000_000;

    // Um arrasto: 100 movimentos em 1 s contam um segundo; mais dois segundos com tecla.
    for (let i = 0; i < 100; i++) usage.note('s1', start + i * 10);
    usage.note('s1', start + 1_200);
    usage.note('s1', start + 2_500);
    http.expectNone(url('s1'));

    vi.advanceTimersByTime(DIRECT_USAGE_FLUSH_MS);
    const request = http.expectOne(url('s1'));
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ totalSeconds: 3 });
    request.flush(null, { status: 204, statusText: 'No Content' });

    // Mais um segundo: o próximo envio leva o TOTAL da sessão (repetir não soma de novo na API).
    usage.note('s1', start + 70_000);
    vi.advanceTimersByTime(DIRECT_USAGE_FLUSH_MS);
    const next = http.expectOne(url('s1'));
    expect(next.request.body).toEqual({ totalSeconds: 4 });
    next.flush(null, { status: 204, statusText: 'No Content' });

    // Sem novidade, nada sai.
    usage.flush();
    http.verify();
  });

  it('reports what is left when the channel closes, with keepalive when the page is leaving', () => {
    const { usage, http } = setup();
    usage.note('s1', 1_000);
    usage.note('s1', 2_000);

    usage.flush({ ended: 's1', keepalive: true });
    const request = http.expectOne(url('s1'));
    expect(request.request.body).toEqual({ totalSeconds: 2 });
    expect(request.request.keepalive).toBe(true);
    request.flush(null, { status: 204, statusText: 'No Content' });

    // Nada pendente: fechar de novo não manda nada.
    usage.flush({ ended: 's1' });
    http.verify();
  });

  it('never sends without a session, caps one report, and ignores a failed report', () => {
    const { usage, http } = setup();
    usage.note(null, 1_000);
    usage.flush();
    http.verify();

    for (let i = 0; i < DIRECT_USAGE_MAX_SECONDS + 50; i++) usage.note('s2', i * 1_000);
    usage.flush();
    const request = http.expectOne(url('s2'));
    expect(request.request.body).toEqual({ totalSeconds: DIRECT_USAGE_MAX_SECONDS });
    expect(() => request.flush(null, { status: 404, statusText: 'Not Found' })).not.toThrow();
    http.verify();
  });

  it('stays silent when there is no HTTP client at all', () => {
    TestBed.configureTestingModule({});
    const usage = TestBed.inject(DirectUsage);
    usage.note('s1', 1_000);
    expect(() => usage.flush()).not.toThrow();
  });
});
