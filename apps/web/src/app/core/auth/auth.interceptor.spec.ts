import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SessionState } from '../session/session-state';
import { ApiProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { StepUpService } from './step-up/step-up.service';

describe('authInterceptor', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };
  const stepUp = { confirm: vi.fn() };
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    api.refresh.mockReset();
    api.me.mockReset().mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'A' });
    stepUp.confirm.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthApi, useValue: api },
        { provide: StepUpService, useValue: stepUp },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    TestBed.inject(SessionState).setToken('jwt-1', 600);
  });

  afterEach(() => backend.verify());

  /** Espera o pedido sair (o interceptor decide de forma assíncrona) e o devolve. */
  async function pending(url: string): Promise<TestRequest> {
    return vi.waitFor(() => {
      const [first] = backend.match((req) => req.url === url);
      if (!first) throw new Error(`sem pedido para ${url}`);
      return first;
    });
  }

  it('adds Bearer to requests for /api/ on the same origin', async () => {
    const result = firstValueFrom(http.get('/api/v1/tv/state'));
    const request = await pending('/api/v1/tv/state');
    expect(request.request.headers.get('Authorization')).toBe('Bearer jwt-1');
    request.flush({});
    await result;
  });

  it('does not add Bearer outside /api/ or to another origin', async () => {
    const own = firstValueFrom(http.get('/assets/x.json'));
    (await pending('/assets/x.json')).flush({});
    await own;
    const foreign = firstValueFrom(http.get('https://outro.exemplo.com/api/v1/x'));
    const request = await pending('https://outro.exemplo.com/api/v1/x');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({});
    await foreign;
  });

  it('does not add Bearer to login and refresh, but sends the client header', async () => {
    const login = firstValueFrom(http.post('/api/v1/identity/auth/login', {}));
    const first = await pending('/api/v1/identity/auth/login');
    expect(first.request.headers.has('Authorization')).toBe(false);
    expect(first.request.headers.get('X-UniOver-Client')).toBe('web');
    first.flush({});
    await login;

    const refresh = firstValueFrom(http.post('/api/v1/identity/auth/refresh', null));
    const second = await pending('/api/v1/identity/auth/refresh');
    expect(second.request.headers.has('Authorization')).toBe(false);
    expect(second.request.headers.get('X-UniOver-Client')).toBe('web');
    second.flush({});
    await refresh;
  });

  it('puts the client header on every POST to identity/auth, but not on GETs or other paths', async () => {
    const ticket = firstValueFrom(http.post('/api/v1/identity/auth/stream-ticket', null));
    const request = await pending('/api/v1/identity/auth/stream-ticket');
    expect(request.request.headers.get('X-UniOver-Client')).toBe('web');
    expect(request.request.headers.get('Authorization')).toBe('Bearer jwt-1');
    request.flush({});
    await ticket;

    const other = firstValueFrom(http.post('/api/v1/tv/command', {}));
    const otherRequest = await pending('/api/v1/tv/command');
    expect(otherRequest.request.headers.has('X-UniOver-Client')).toBe(false);
    otherRequest.flush({});
    await other;
  });

  it('keeps a header that the caller already set', async () => {
    const result = firstValueFrom(
      http.post('/api/v1/identity/auth/login', {}, { headers: { 'X-UniOver-Client': 'web' } }),
    );
    const request = await pending('/api/v1/identity/auth/login');
    expect(request.request.headers.getAll('X-UniOver-Client')).toEqual(['web']);
    request.flush({});
    await result;
  });

  it('sends no Authorization when there is no session', async () => {
    TestBed.inject(SessionState).clear('anonymous');
    const result = firstValueFrom(http.get('/api/v1/identity/me')).catch(() => undefined);
    const request = await pending('/api/v1/identity/me');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({}, { status: 401, statusText: 'Unauthorized' });
    await result;
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('renews once on 401 and repeats the request once with the new token', async () => {
    api.refresh.mockResolvedValue({ accessToken: 'jwt-2', expiresIn: 600 });
    const result = firstValueFrom(http.get('/api/v1/tv/state'));
    (await pending('/api/v1/tv/state')).flush({}, { status: 401, statusText: 'Unauthorized' });
    const retry = await pending('/api/v1/tv/state');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer jwt-2');
    retry.flush({ ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not loop when the repeated request is 401 again', async () => {
    api.refresh.mockResolvedValue({ accessToken: 'jwt-2', expiresIn: 600 });
    const result = firstValueFrom(http.get('/api/v1/tv/state')).catch((e: unknown) => e);
    (await pending('/api/v1/tv/state')).flush({}, { status: 401, statusText: 'Unauthorized' });
    (await pending('/api/v1/tv/state')).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(await result).toMatchObject({ status: 401 });
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it('on 403 step-up asks for the passkey and repeats once', async () => {
    stepUp.confirm.mockResolvedValue(true);
    const result = firstValueFrom(http.delete('/api/v1/identity/passkeys/p1'));
    (await pending('/api/v1/identity/passkeys/p1')).flush(
      {
        type: 'https://uniover.app/problems/step-up-required',
        code: 'step_up_required',
        action: 'identity.passkey-remove',
      },
      { status: 403, statusText: 'Forbidden' },
    );
    (await pending('/api/v1/identity/passkeys/p1')).flush(null, {
      status: 204,
      statusText: 'No Content',
    });
    await result;
    expect(stepUp.confirm).toHaveBeenCalledWith('identity.passkey-remove');
  });

  it('does not repeat and does not loop when step-up is declined or still required', async () => {
    const body = {
      type: 'https://uniover.app/problems/step-up-required',
      code: 'step_up_required',
      action: 'a.b',
    };
    stepUp.confirm.mockResolvedValue(false);
    const declined = firstValueFrom(http.delete('/api/v1/x/1')).catch((e: unknown) => e);
    (await pending('/api/v1/x/1')).flush(body, { status: 403, statusText: 'Forbidden' });
    expect(await declined).toMatchObject({ status: 403 });

    stepUp.confirm.mockResolvedValue(true);
    const again = firstValueFrom(http.delete('/api/v1/x/2')).catch((e: unknown) => e);
    (await pending('/api/v1/x/2')).flush(body, { status: 403, statusText: 'Forbidden' });
    (await pending('/api/v1/x/2')).flush(body, { status: 403, statusText: 'Forbidden' });
    expect(await again).toMatchObject({ status: 403 });
    expect(stepUp.confirm).toHaveBeenCalledTimes(2);
  });

  describe('403 of access', () => {
    const forbiddenBody = {
      type: 'https://uniover.app/problems/forbidden',
      title: 'Sem permissão.',
    };
    const forbidden = { status: 403, statusText: 'Forbidden' };

    // Uma convidada com a sessão aberta e a conta já lida (o administrador nunca relê por 403).
    beforeEach(() => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'guest',
        permissions: ['module:tv', 'tv:power'],
      });
    });
    afterEach(() => localStorage.clear());

    it('re-reads the account once so the screen follows, and the call still fails', async () => {
      const session = TestBed.inject(SessionState);
      api.me.mockResolvedValue({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'guest',
        permissions: ['module:tv'],
      });
      const first = firstValueFrom(http.post('/api/v1/tv/power', {})).catch((e: unknown) => e);
      (await pending('/api/v1/tv/power')).flush(forbiddenBody, forbidden);
      expect(await first).toMatchObject({ status: 403 });
      await vi.waitFor(() => expect(session.permissions()).toEqual(['module:tv']));
      expect(api.me).toHaveBeenCalledTimes(1);
      expect(api.me).toHaveBeenCalledWith('jwt-1');

      // A recusa seguinte, logo depois, não gera outra leitura.
      const second = firstValueFrom(http.post('/api/v1/tv/power', {})).catch((e: unknown) => e);
      (await pending('/api/v1/tv/power')).flush(forbiddenBody, forbidden);
      expect(await second).toMatchObject({ status: 403 });
      expect(api.me).toHaveBeenCalledTimes(1);
    });

    it('does not re-read for the 403 of the passkey, nor for a typed refusal of another subject', async () => {
      stepUp.confirm.mockResolvedValue(false);
      const declined = firstValueFrom(http.delete('/api/v1/x/1')).catch((e: unknown) => e);
      (await pending('/api/v1/x/1')).flush(
        {
          type: 'https://uniover.app/problems/step-up-required',
          code: 'step_up_required',
          action: 'a.b',
        },
        forbidden,
      );
      expect(await declined).toMatchObject({ status: 403 });

      const typed = firstValueFrom(http.post('/api/v1/identity/step-up/options', {})).catch(
        (e: unknown) => e,
      );
      (await pending('/api/v1/identity/step-up/options')).flush(
        { type: 'https://uniover.app/problems/invalid-password', title: 'Senha incorreta.' },
        forbidden,
      );
      expect(await typed).toMatchObject({ status: 403 });
      expect(api.me).not.toHaveBeenCalled();
    });
  });

  it('a network failure does not touch the session', async () => {
    const session = TestBed.inject(SessionState);
    const result = firstValueFrom(http.get('/api/v1/tv/state')).catch((e: unknown) => e);
    (await pending('/api/v1/tv/state')).error(new ProgressEvent('error'), { status: 0 });
    await result;
    expect(session.status()).toBe('authenticated');
    expect(session.bearer()).toBe('jwt-1');
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('a failed renewal leaves the session pending when there is no network (nothing is erased)', async () => {
    localStorage.setItem('chave-local', 'valor');
    api.refresh.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
    const result = firstValueFrom(http.get('/api/v1/tv/state')).catch((e: unknown) => e);
    (await pending('/api/v1/tv/state')).flush({}, { status: 401, statusText: 'Unauthorized' });
    await result;
    expect(localStorage.getItem('chave-local')).toBe('valor');
    expect(TestBed.inject(AuthService).status()).not.toBe('anonymous');
    expect(TestBed.inject(Router).url).toBe('/');
  });
});
