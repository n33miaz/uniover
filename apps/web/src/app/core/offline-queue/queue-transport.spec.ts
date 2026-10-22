import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth.service';
import { SessionState } from '../session/session-state';
import { QUEUE_TRANSPORT, QueueRequest, SEND_TIMEOUT_MS } from './queue-transport';

const request: QueueRequest = {
  accountId: 'conta-a',
  method: 'POST',
  url: '/api/v1/test/items',
  body: { name: 'x' },
  headers: {
    'Idempotency-Key': '0199aaaa-0000-7000-8000-000000000001',
    'Content-Type': 'application/json',
  },
};

describe('HttpClientQueueTransport', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: { accessToken: async () => null, renew: async () => 'unavailable' },
        },
        { provide: SessionState, useValue: { bearerOf: () => 'token-da-conta-a' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('sends the JSON body with the idempotency key and reports a 2xx with its headers in lower case', async () => {
    const result = TestBed.inject(QUEUE_TRANSPORT).send(request);
    const call = http.expectOne('/api/v1/test/items');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toBe('{"name":"x"}');
    expect(call.request.headers.get('Idempotency-Key')).toBe(request.headers['Idempotency-Key']);
    expect(call.request.headers.get('Content-Type')).toBe('application/json');
    expect(call.request.headers.get('Authorization')).toBe('Bearer token-da-conta-a');
    call.flush('{"id":1}', {
      status: 201,
      statusText: 'Created',
      headers: { 'Idempotent-Replayed': 'true' },
    });

    expect(await result).toEqual({
      kind: 'response',
      status: 201,
      headers: { 'idempotent-replayed': 'true' },
    });
  });

  it('sends no body when the request has none', async () => {
    const result = TestBed.inject(QUEUE_TRANSPORT).send({
      ...request,
      method: 'DELETE',
      body: undefined,
    });
    const call = http.expectOne('/api/v1/test/items');
    expect(call.request.body).toBeNull();
    call.flush(null, { status: 204, statusText: 'No Content' });
    expect((await result).kind).toBe('response');
  });

  it('turns an error status into a response outcome and extracts the end of the problem type', async () => {
    const result = TestBed.inject(QUEUE_TRANSPORT).send(request);
    http.expectOne('/api/v1/test/items').flush(
      JSON.stringify({
        type: 'https://uniover.app/problems/idempotency-in-progress',
        status: 409,
      }),
      { status: 409, statusText: 'Conflict', headers: { 'Retry-After': '2' } },
    );

    expect(await result).toEqual({
      kind: 'response',
      status: 409,
      headers: { 'retry-after': '2' },
      problemType: 'idempotency-in-progress',
    });
  });

  it('keeps the status of an error whose body is not a problem', async () => {
    const result = TestBed.inject(QUEUE_TRANSPORT).send(request);
    http.expectOne('/api/v1/test/items').flush('<html>nao e json</html>', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'x-render-routing': 'hibernate-wake' },
    });

    expect(await result).toEqual({
      kind: 'response',
      status: 503,
      headers: { 'x-render-routing': 'hibernate-wake' },
    });
  });

  it('reports a request that got no response as a network error', async () => {
    const result = TestBed.inject(QUEUE_TRANSPORT).send(request);
    http.expectOne('/api/v1/test/items').error(new ProgressEvent('error'));
    expect(await result).toEqual({ kind: 'network-error' });
  });

  it('gives up on a request that never answers after the timeout and reports a network error', async () => {
    vi.useFakeTimers();
    const result = TestBed.inject(QUEUE_TRANSPORT).send(request);
    http.expectOne('/api/v1/test/items');
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    expect(await result).toEqual({ kind: 'network-error' });
  });
});
