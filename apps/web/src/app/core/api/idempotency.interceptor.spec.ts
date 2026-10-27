import { HttpClient, HttpRequest, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IDEMPOTENCY_HEADER } from './idempotency';
import { idempotencyInterceptor } from './idempotency.interceptor';

const GUEST_REVOKE = '/api/v1/identity/guests/g1/revoke';
const keyOf = (req: HttpRequest<unknown>) => req.headers.get(IDEMPOTENCY_HEADER);

describe('idempotencyInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([idempotencyInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('adds a UUID key to a write that the API asks it for', () => {
    http.post(GUEST_REVOKE, { displayName: 'Ana' }).subscribe();
    const req = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(req.request)).toMatch(/^[0-9a-f-]{36}$/);
    req.flush({});
  });

  it('leaves other calls alone: reads and TV commands', () => {
    http.get('/api/v1/identity/me').subscribe();
    const read = backend.expectOne('/api/v1/identity/me');
    expect(read.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
    read.flush({});

    http.post('/api/v1/tv/keys', { key: 'up' }).subscribe();
    const keys = backend.expectOne('/api/v1/tv/keys');
    expect(keys.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
    keys.flush({});

    // O convite devolve o token em claro: a API não o guarda, então o site também não manda chave.
    http.post('/api/v1/identity/guest-invites', { displayName: 'Ana' }).subscribe();
    const invite = backend.expectOne('/api/v1/identity/guest-invites');
    expect(invite.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
    invite.flush({});
  });

  it('does not add the key to another origin', () => {
    const url = `https://outro.example${GUEST_REVOKE}`;
    http.post(url, {}).subscribe();
    const req = backend.expectOne(url);
    expect(req.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
    req.flush({});
  });

  it('keeps a key that is already there', () => {
    http.post(GUEST_REVOKE, {}, { headers: { [IDEMPOTENCY_HEADER]: 'minha-chave' } }).subscribe();
    const req = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(req.request)).toBe('minha-chave');
    req.flush({});
  });

  it('resends the same action with the same key after the server failed, then moves on after success', () => {
    const body = { displayName: 'Ana' };

    http.post(GUEST_REVOKE, body).subscribe({ error: () => undefined });
    const failed = backend.expectOne(GUEST_REVOKE);
    const firstKey = keyOf(failed.request);
    failed.flush({}, { status: 503, statusText: 'indisponível' });

    http.post(GUEST_REVOKE, body).subscribe();
    const retried = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(retried.request)).toBe(firstKey);
    retried.flush({});

    http.post(GUEST_REVOKE, body).subscribe();
    const next = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(next.request)).not.toBe(firstKey);
    next.flush({});
  });

  it('uses a new key after a definitive refusal (the API stores that 4xx answer under the key)', () => {
    http.post(GUEST_REVOKE, {}).subscribe({ error: () => undefined });
    const refused = backend.expectOne(GUEST_REVOKE);
    const firstKey = keyOf(refused.request);
    refused.flush(
      { type: 'https://uniover/problems/step-up-required', title: 'Confirme' },
      { status: 403, statusText: 'proibido' },
    );

    http.post(GUEST_REVOKE, {}).subscribe();
    const again = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(again.request)).not.toBe(firstKey);
    again.flush({});
  });

  it('keeps the key when the API says the first attempt is still running', () => {
    http.post(GUEST_REVOKE, {}).subscribe({ error: () => undefined });
    const busy = backend.expectOne(GUEST_REVOKE);
    const firstKey = keyOf(busy.request);
    busy.flush(
      { type: 'https://uniover/problems/idempotency-in-progress', title: 'Em andamento' },
      { status: 409, statusText: 'conflito' },
    );

    http.post(GUEST_REVOKE, {}).subscribe();
    const again = backend.expectOne(GUEST_REVOKE);
    expect(keyOf(again.request)).toBe(firstKey);
    again.flush({});
  });
});
