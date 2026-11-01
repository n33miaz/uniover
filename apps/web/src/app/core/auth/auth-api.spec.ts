import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { ApiProblem } from './api-problem';
import { AuthApi, FETCH_FN } from './auth-api';
import { DEVICE_KEYS, DeviceKeys, PendingDeviceKey } from './device-keys';

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

  it('the QR sign-in calls are POSTs with the client header; secret and code travel in the body, never in the URL', async () => {
    fetchFn.mockResolvedValue(reply(200, { status: 'pending' }));
    await api().qrStart();
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'POST',
      '/api/v1/identity/auth/qr/start',
    ]);
    expect(lastCall().headers['Authorization']).toBeUndefined();

    await api().qrPoll('segredo-de-consulta');
    expect(lastCall().url).toBe('/api/v1/identity/auth/qr/poll');
    expect(lastCall().headers['X-UniOver-Client']).toBe('web');
    expect(lastCall().headers['Authorization']).toBeUndefined();
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ secret: 'segredo-de-consulta' });

    await api().qrInfo('jwt', 'CODIGO');
    expect(lastCall().url).toBe('/api/v1/identity/auth/qr/info');
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ code: 'CODIGO' });

    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api().qrApprove('jwt', 'CODIGO', 'minha-senha')).resolves.toBeUndefined();
    expect(lastCall().url).toBe('/api/v1/identity/auth/qr/approve');
    expect(lastCall().headers['X-UniOver-Client']).toBe('web');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      code: 'CODIGO',
      password: 'minha-senha',
    });
    await expect(api().qrDeny('jwt', 'CODIGO')).resolves.toBeUndefined();
    expect(lastCall().url).toBe('/api/v1/identity/auth/qr/deny');

    for (const [url] of fetchFn.mock.calls) {
      expect(url).not.toContain('segredo-de-consulta');
      expect(url).not.toContain('CODIGO');
    }
  });

  it('authenticated calls carry the Bearer token; the token never appears in a URL', async () => {
    fetchFn.mockResolvedValue(reply(200, []));
    await api().passkeys('jwt-secreto');
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt-secreto');
    for (const [url] of fetchFn.mock.calls) expect(url).not.toContain('jwt-secreto');
  });

  it('uses the correct account paths for listing and revoking sessions', async () => {
    fetchFn.mockResolvedValue(reply(200, []));
    await api().sessions('jwt');
    expect([lastCall().init.method, lastCall().url]).toEqual(['GET', '/api/v1/identity/sessions']);
    await api().sessions('jwt', 'guest id');
    expect(lastCall().url).toBe('/api/v1/identity/guests/guest%20id/sessions');

    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await api().revokeSession('jwt', 'session id');
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'POST',
      '/api/v1/identity/sessions/session%20id/revoke',
    ]);
    await api().revokeSession('jwt', 'session id', 'guest id');
    expect(lastCall().url).toBe('/api/v1/identity/guests/guest%20id/sessions/session%20id/revoke');
    await api().revokeOtherSessions('jwt');
    expect(lastCall().url).toBe('/api/v1/identity/sessions/others/revoke');
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt');
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

  it('the guest confirms an action with the password, sent in the body with the bearer token', async () => {
    fetchFn.mockResolvedValue(reply(200, { action: 'devices.pair-self', expiresAt: 'x' }));
    await api().stepUpWithPassword('t', 'devices.pair-self', 'minha-senha');
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/identity/step-up/password');
    expect(init.method).toBe('POST');
    expect(headers['Authorization']).toBe('Bearer t');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'devices.pair-self',
      password: 'minha-senha',
    });
  });

  it('accepting an invite is a public POST with the client header; the secret goes in the body, never in the URL', async () => {
    fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 600 }));
    await api().acceptInvite('segredo-do-convite', 'ana@exemplo.com', 'uma-senha-longa');
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/identity/guest-invites/accept');
    expect(init.method).toBe('POST');
    expect(headers['X-UniOver-Client']).toBe('web');
    expect(headers['Authorization']).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'segredo-do-convite',
      email: 'ana@exemplo.com',
      password: 'uma-senha-longa',
    });
    for (const [called] of fetchFn.mock.calls) expect(called).not.toContain('segredo');
  });

  it('uses the verbs and paths of the invite and guest endpoints, all with the Bearer token', async () => {
    fetchFn.mockResolvedValue(reply(200, []));
    await api().guestInvites('jwt');
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'GET',
      '/api/v1/identity/guest-invites',
    ]);
    await api().guests('jwt');
    expect([lastCall().init.method, lastCall().url]).toEqual(['GET', '/api/v1/identity/guests']);
    fetchFn.mockResolvedValue(
      reply(200, { id: 'i', displayName: 'Ana', token: 'x', expiresAt: '' }),
    );
    await api().createGuestInvite('jwt', 'Ana');
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'POST',
      '/api/v1/identity/guest-invites',
    ]);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ displayName: 'Ana' });
    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await api().revokeGuestInvite('jwt', 'i-1');
    expect(lastCall().url).toBe('/api/v1/identity/guest-invites/i-1/revoke');
    await api().revokeGuest('jwt', 'g-1');
    expect([lastCall().init.method, lastCall().url]).toEqual([
      'POST',
      '/api/v1/identity/guests/g-1/revoke',
    ]);
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt');
  });

  it('updating the profile is a PATCH on /me with the Bearer token and only the name in the body', async () => {
    fetchFn.mockResolvedValue(
      reply(200, {
        id: 'u1',
        email: 'a@b.c',
        displayName: 'Ana',
        role: 'owner',
        displayNameConfirmed: true,
        permissions: [],
      }),
    );
    await expect(api().updateMe('jwt', 'Ana')).resolves.toMatchObject({
      displayName: 'Ana',
      displayNameConfirmed: true,
    });
    expect([lastCall().init.method, lastCall().url]).toEqual(['PATCH', '/api/v1/identity/me']);
    expect(lastCall().headers['Authorization']).toBe('Bearer jwt');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ displayName: 'Ana' });
    // Não é rota de autenticação: sem o cabeçalho do cliente (só os POST de /auth/* o levam).
    expect(lastCall().headers['X-UniOver-Client']).toBeUndefined();
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

  describe('Idempotency-Key', () => {
    const keyOfLastCall = () => lastCall().headers['Idempotency-Key'];

    it('rewrite routes carry a UUID key; read and login/refresh calls do not', async () => {
      fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
      await api().revokeGuest('jwt', 'g-1');
      expect(keyOfLastCall()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      await api().removePasskey('jwt', 'p-1');
      expect(keyOfLastCall()).toBeDefined();
      await api().revokeSession('jwt', 's-1');
      expect(keyOfLastCall()).toBeDefined();
      await api().revokeOtherSessions('jwt');
      expect(keyOfLastCall()).toBeDefined();

      fetchFn.mockResolvedValue(reply(200, []));
      await api().guests('jwt');
      expect(keyOfLastCall()).toBeUndefined();
      fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
      await api().refresh();
      expect(keyOfLastCall()).toBeUndefined();
      await api().login('a@b.c', 'senha');
      expect(keyOfLastCall()).toBeUndefined();
    });

    it('resending the same action after a network failure reuses the key', async () => {
      fetchFn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await api()
        .updateMe('jwt', 'Ana')
        .catch(() => undefined);
      const first = keyOfLastCall();

      fetchFn.mockResolvedValue(reply(200, { id: 'u1' }));
      await api().updateMe('jwt', 'Ana');
      expect(keyOfLastCall()).toBe(first);
    });

    it('a server error keeps the key; a definitive answer (success or 4xx) makes the next attempt use a new one', async () => {
      fetchFn.mockResolvedValueOnce(reply(503, {}));
      await api()
        .revokeGuest('jwt', 'g-1')
        .catch(() => undefined);
      const first = keyOfLastCall();

      fetchFn.mockResolvedValueOnce(
        reply(403, { type: 'https://uniover/problems/step-up-required', title: 'x' }),
      );
      await api()
        .revokeGuest('jwt', 'g-1')
        .catch(() => undefined);
      expect(keyOfLastCall()).toBe(first);

      // A API guardou a recusa sob a chave: a próxima tentativa da ação precisa de chave nova.
      fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await api().revokeGuest('jwt', 'g-1');
      const afterRefusal = keyOfLastCall();
      expect(afterRefusal).not.toBe(first);

      fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await api().revokeGuest('jwt', 'g-1');
      expect(keyOfLastCall()).not.toBe(afterRefusal);
    });

    it('another body is another action and gets its own key', async () => {
      fetchFn.mockRejectedValue(new TypeError('Failed to fetch'));
      await api()
        .updateMe('jwt', 'Ana')
        .catch(() => undefined);
      const ana = keyOfLastCall();
      await api()
        .updateMe('jwt', 'Bia')
        .catch(() => undefined);
      expect(keyOfLastCall()).not.toBe(ana);
    });
  });

  describe('device key and recovery', () => {
    const commit = vi.fn();
    const create = vi.fn();
    const keys: DeviceKeys = { create, hasKey: vi.fn(), sign: vi.fn() };
    const pending = (publicKey: string): PendingDeviceKey => ({ publicKey, commit });
    const tokens = { accessToken: 't', expiresIn: 600 };

    beforeEach(() => {
      commit.mockReset().mockResolvedValue(undefined);
      create.mockReset();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: FETCH_FN, useValue: fetchFn },
          { provide: DEVICE_KEYS, useValue: keys },
        ],
      });
    });

    it.each([
      ['login', () => api().login('a@b.c', 'senha')],
      ['invite accept', () => api().acceptInvite('segredo', 'a@b.c', 'senha-longa-1')],
    ])(
      '%s sends the public key of a fresh pair and keeps the pair only after it worked',
      async (_n, call) => {
        create.mockResolvedValue(pending('chave-publica-1'));
        fetchFn.mockResolvedValue(reply(200, tokens));

        await call();

        expect(lastCall().headers['X-UniOver-Device-Key']).toBe('chave-publica-1');
        expect(commit).toHaveBeenCalledTimes(1);
      },
    );

    it('a failed sign-in does not store the pair, and the next attempt reuses the same one', async () => {
      create.mockResolvedValue(pending('chave-publica-1'));
      fetchFn.mockResolvedValueOnce(reply(401, { title: 'x' }));
      await api()
        .login('a@b.c', 'errada')
        .catch(() => undefined);
      expect(commit).not.toHaveBeenCalled();

      fetchFn.mockResolvedValueOnce(reply(200, tokens));
      await api().login('a@b.c', 'certa');

      expect(create).toHaveBeenCalledTimes(1);
      expect(lastCall().headers['X-UniOver-Device-Key']).toBe('chave-publica-1');
      expect(commit).toHaveBeenCalledTimes(1);

      // A entrada seguinte é outra sessão: outro par.
      create.mockResolvedValue(pending('chave-publica-2'));
      fetchFn.mockResolvedValueOnce(reply(200, tokens));
      await api().login('a@b.c', 'certa');
      expect(lastCall().headers['X-UniOver-Device-Key']).toBe('chave-publica-2');
    });

    it('the QR poll keeps the pair only when the poll came back approved with a token', async () => {
      create.mockResolvedValue(pending('chave-qr'));
      fetchFn.mockResolvedValueOnce(reply(200, { status: 'pending', accessToken: null }));
      await api().qrPoll('segredo');
      expect(lastCall().headers['X-UniOver-Device-Key']).toBe('chave-qr');
      expect(commit).not.toHaveBeenCalled();

      fetchFn.mockResolvedValueOnce(reply(200, { status: 'approved', ...tokens }));
      await api().qrPoll('segredo');
      expect(create).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('signs in with no key header when the browser cannot make one, and does not fail', async () => {
      create.mockResolvedValue(null);
      fetchFn.mockResolvedValue(reply(200, tokens));

      await expect(api().login('a@b.c', 'senha')).resolves.toEqual(tokens);

      expect(lastCall().headers['X-UniOver-Device-Key']).toBeUndefined();
    });

    it('a storage failure after a good sign-in does not undo the sign-in', async () => {
      create.mockResolvedValue(pending('chave'));
      commit.mockRejectedValue(new Error('quota'));
      fetchFn.mockResolvedValue(reply(200, tokens));

      await expect(api().login('a@b.c', 'senha')).resolves.toEqual(tokens);
    });

    it('the plain refresh carries no key and no proof', async () => {
      fetchFn.mockResolvedValue(reply(200, tokens));

      await api().refresh();

      const { headers } = lastCall();
      expect(headers['X-UniOver-Device-Key']).toBeUndefined();
      expect(headers['X-UniOver-Recovery-Challenge']).toBeUndefined();
      expect(headers['X-UniOver-Recovery-Proof']).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
    });

    it('the recovering refresh carries the challenge and the proof', async () => {
      fetchFn.mockResolvedValue(reply(200, tokens));

      await api().refresh({ challenge: 'id.nonce', proof: 'assinatura' });

      const { url, headers } = lastCall();
      expect(url).toBe('/api/v1/identity/auth/refresh');
      expect(headers['X-UniOver-Recovery-Challenge']).toBe('id.nonce');
      expect(headers['X-UniOver-Recovery-Proof']).toBe('assinatura');
      expect(headers['X-UniOver-Client']).toBe('web');
    });

    it('asks for the challenge with a POST that has the client header and no body', async () => {
      fetchFn.mockResolvedValue(
        reply(200, { challenge: 'id.nonce', familyId: 'f', expiresIn: 120 }),
      );

      await expect(api().refreshChallenge()).resolves.toEqual({
        challenge: 'id.nonce',
        familyId: 'f',
        expiresIn: 120,
      });

      const { url, init, headers } = lastCall();
      expect(url).toBe('/api/v1/identity/auth/refresh/challenge');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(headers['X-UniOver-Client']).toBe('web');
    });
  });

  describe('device and installed app, reported to the API', () => {
    const IPHONE =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    afterEach(() => vi.unstubAllGlobals());

    function fakeWindow(userAgent: string, standalone?: boolean): void {
      vi.stubGlobal('window', {
        navigator: { userAgent, standalone, maxTouchPoints: 5, platform: 'iPhone' },
        matchMedia: () => ({ matches: false }),
      });
    }

    it('the refresh and the login carry the device and whether the app is installed', async () => {
      fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
      fakeWindow(IPHONE, true);

      await api().refresh();
      expect(lastCall().headers['X-UniOver-Client-Env']).toBe('iphone;standalone');
      await api().login('a@b.c', 'senha');
      expect(lastCall().headers['X-UniOver-Client-Env']).toBe('iphone;standalone');
    });

    it('says "browser" for a Safari tab', async () => {
      fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
      fakeWindow(IPHONE, false);

      await api().refresh();

      expect(lastCall().headers['X-UniOver-Client-Env']).toBe('iphone;browser');
    });

    it('reads the window at the time of each call (installing between two renewals shows up)', async () => {
      fetchFn.mockResolvedValue(reply(200, { accessToken: 't', expiresIn: 1 }));
      fakeWindow(IPHONE, false);
      await api().refresh();
      fakeWindow(IPHONE, true);
      await api().refresh();

      expect(lastCall().headers['X-UniOver-Client-Env']).toBe('iphone;standalone');
    });

    it('does not tell the device on reads, only on the entries that open or renew a session', async () => {
      fetchFn.mockResolvedValue(reply(200, { id: 'u1' }));
      fakeWindow(IPHONE, true);

      await api().me('jwt');

      expect(lastCall().headers['X-UniOver-Client-Env']).toBeUndefined();
    });
  });
});
