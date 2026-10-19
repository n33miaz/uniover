import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from './connectivity.service';
import { connectivityInterceptor } from './connectivity.interceptor';

describe('connectivityInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let connectivity: ConnectivityService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([connectivityInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    connectivity = TestBed.inject(ConnectivityService);
    vi.spyOn(connectivity, 'reportRequestFailure');
    vi.spyOn(connectivity, 'reportRequestSuccess');
  });

  it('reports a failure when the request gets no response', () => {
    http.get('/api/x').subscribe({ error: () => undefined });
    backend.expectOne('/api/x').error(new ProgressEvent('error'), { status: 0 });
    expect(connectivity.reportRequestFailure).toHaveBeenCalled();
  });

  it('does not treat an HTTP error status as the server being down', () => {
    http.get('/api/x').subscribe({ error: () => undefined });
    backend.expectOne('/api/x').flush('x', { status: 500, statusText: 'erro' });
    expect(connectivity.reportRequestFailure).not.toHaveBeenCalled();
  });

  it('reports success on a response', () => {
    http.get('/api/x').subscribe();
    backend.expectOne('/api/x').flush({});
    expect(connectivity.reportRequestSuccess).toHaveBeenCalled();
  });
});
