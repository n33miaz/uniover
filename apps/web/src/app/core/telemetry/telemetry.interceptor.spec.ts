import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { connectivityInterceptor } from '../connectivity/connectivity.interceptor';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { QUIET_REQUEST } from '../connectivity/quiet-request';
import { ClientTelemetry } from './client-telemetry';
import { telemetryInterceptor } from './telemetry.interceptor';

describe('telemetryInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let telemetry: ClientTelemetry;
  let connectivity: ConnectivityService;

  beforeEach(() => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    window.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof window.fetch;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([telemetryInterceptor, connectivityInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    telemetry = TestBed.inject(ClientTelemetry);
    connectivity = TestBed.inject(ConnectivityService);
    vi.spyOn(telemetry, 'recordHttp');
    vi.spyOn(connectivity, 'reportRequestFailure');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands a failed request to the telemetry, with the method and the address', () => {
    http.get('/api/v1/tv/state').subscribe({ error: () => undefined });
    backend.expectOne('/api/v1/tv/state').flush('x', { status: 503, statusText: 'fora' });
    expect(telemetry.recordHttp).toHaveBeenCalledWith(
      'GET',
      '/api/v1/tv/state',
      expect.objectContaining({ status: 503 }),
    );
  });

  it('does not touch a successful request', () => {
    http.get('/api/x').subscribe();
    backend.expectOne('/api/x').flush({});
    expect(telemetry.recordHttp).not.toHaveBeenCalled();
  });

  it('leaves the telemetry send out of both the telemetry and the connectivity', () => {
    const context = new HttpContext().set(QUIET_REQUEST, true);
    http
      .post('/api/v1/devices/client-events', {}, { context })
      .subscribe({ error: () => undefined });
    backend
      .expectOne('/api/v1/devices/client-events')
      .error(new ProgressEvent('error'), { status: 0, statusText: '' });
    expect(telemetry.recordHttp).not.toHaveBeenCalled();
    expect(connectivity.reportRequestFailure).not.toHaveBeenCalled();
  });
});
