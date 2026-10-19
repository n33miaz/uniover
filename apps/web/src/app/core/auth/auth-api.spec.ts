import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { ApiProblem } from './api-problem';
import { AuthApi, FETCH_FN } from './auth-api';

function reply(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('AuthApi', () => {
  const fetchFn = vi.fn();

  beforeEach(() => {
    fetchFn.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: FETCH_FN, useValue: fetchFn }] });
  });

  const api = () => TestBed.inject(AuthApi);
  const lastCall = () => {
    const [url, init] = fetchFn.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string> };
  };

  it('login sends the client header and the credentials, with no Authorization', async () => {
    fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 600 }));
    await expect(api().login('a@b.c', 'senha')).resolves.toEqual({
      accessToken: 't',
      expiresIn: 600,
    });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/identity/auth/login');
    expect(init.method).toBe('POST');
    expect(headers['X-UniOver-Client']).toBe('web');
    expect(headers['Authorization']).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.c', password: 'senha' });
  });

  it.each([
    ['refresh', () => api().refresh(), '/api/v1/identity/auth/refresh'],
    ['logout', () => api().logout('t'), '/api/v1/identity/auth/logout'],
    ['stream-ticket', () => api().streamTicket('t'), '/api/v1/identity/auth/stream-ticket'],
  ])('%s is a POST with the client header', async (_name, call, path) => {
    fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
    await call();
    expect(lastCall().url).toBe(path);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().headers['X-UniOver-Client']).toBe('web');
  });

  it('authenticated calls carry the Bearer token; the token never appears in a URL', async () => {
    fetchFn.mockResolvedValue(reply(200, []));
    await api().passkeys('jwt-secreto');
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt-secreto');
    for (const [url] of fetchFn.mock.calls) expect(url).not.toContain('jwt-secreto');
  });

  it('uses the verbs and paths of the passkey and step-up endpoints', async () => {
    fetchFn.mockResolvedValue(reply(200, {}));
    await api().renamePasskey('t', 'id-1', 'Novo');
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'PATCH',
      '/api/v1/identity/passkeys/id-1',
    ]);
    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api().removePasskey('t', 'id-1')).resolves.toBeUndefined();
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'DELETE',
      '/api/v1/identity/passkeys/id-1',
    ]);
    fetchFn.mockResolvedValue(reply(200, { challengeId: 'c', options: {} }));
    await api().registrationOptions('t', 'senha');
    expect(lastCall().url).toBe('/api/v1/identity/passkeys/registration/options');
    await api().stepUpOptions('t', 'identity.passkey-remove');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      action: 'identity.passkey-remove',
    });
    await api().stepUpComplete('t', 'c', { id: 'x' });
    expect(lastCall().url).toBe('/api/v1/identity/step-up/complete');
    fetchFn.mockResolvedValue(reply(201, { id: 'p' }));
    await api().registrationComplete('t', 'c', null, { id: 'x' });
    expect(lastCall().url).toBe('/api/v1/identity/passkeys/registration/complete');
  });

  it('turns an error response into an ApiProblem with kind and Retry-After', async () => {
    fetchFn.mockResolvedValue(
      reply(429, { type: 'https://uniover.app/problems/login-locked' }, { 'Retry-After': '90' }),
    );
    const error = await api()
      .login('a@b.c', 'x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).kind).toBe('login-locked');
    expect((error as ApiProblem).retryAfterSeconds).toBe(90);
  });

  it('reports a network failure to the connectivity service and throws status 0', async () => {
    const connectivity = TestBed.inject(ConnectivityService);
    const failure = vi.spyOn(connectivity, 'reportRequestFailure');
    fetchFn.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await api()
      .refresh()
      .catch((e: unknown) => e)) as ApiProblem;
    expect(error.isNetwork).toBe(true);
    expect(failure).toHaveBeenCalled();
  });

  it('reports success to the connectivity service when the server answers, even with an error status', async () => {
    const connectivity = TestBed.inject(ConnectivityService);
    const success = vi.spyOn(connectivity, 'reportRequestSuccess');
    fetchFn.mockResolvedValue(reply(401, {}));
    await api()
      .refresh()
      .catch(() => undefined);
    expect(success).toHaveBeenCalled();
  });

  it('never caches and always sends same-origin credentials (the HttpOnly cookie)', async () => {
    fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
    await api().refresh();
    expect(lastCall().init.cache).toBe('no-store');
    expect(lastCall().init.credentials).toBe('same-origin');
  });
});
