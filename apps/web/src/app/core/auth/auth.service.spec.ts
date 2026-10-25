import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import 'fake-indexeddb/auto';
import { MODULE_PREFS_KEY } from '../modules/module-prefs';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi, TokenResponse } from './auth-api';
import { AuthService } from './auth.service';
import { StepUpService } from './step-up/step-up.service';

@Component({ template: '' })
class Blank {}

const ME = { id: 'u1', email: 'dono@exemplo.com', displayName: 'Dono' };
const tokens = (name: string, expiresIn = 600): TokenResponse => ({
  accessToken: name,
  expiresIn,
});
const problem = (status: number, kind = '', action: string | null = null) =>
  new ApiProblem(status, kind, 'x', null, action);
const stepUpProblem = () => new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'a.b');

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('uniover-test', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('queue');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbPut(value: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(value, 'item');
    tx.oncomplete = () => resolve();
  });
  db.close();
}
async function dbGet(): Promise<unknown> {
  const db = await openDb();
  const value = await new Promise((resolve) => {
    const request = db.transaction('queue').objectStore('queue').get('item');
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  return value;
}

describe('AuthService', () => {
  const api = {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    updateMe: vi.fn(),
  };
  const stepUp = { confirm: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    localStorage.clear();
    sessionStorage.clear();
    for (const fn of [...Object.values(api), stepUp.confirm]) fn.mockReset();
    api.me.mockResolvedValue(ME);
    api.logout.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Blank },
          { path: 'tv', component: Blank },
          { path: '', component: Blank },
        ]),
        { provide: AuthApi, useValue: api },
        { provide: StepUpService, useValue: stepUp },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    // Os arquivos de teste dividem o mesmo `localStorage` (o executor não isola o ambiente entre eles): a dica do papel
    // ("convidado") que uma leitura de `/me` deixa aqui não pode chegar ao arquivo seguinte.
    localStorage.clear();
  });

  const service = () => TestBed.inject(AuthService);
  const session = () => TestBed.inject(SessionState);

  describe('init', () => {
    it('authenticates when the refresh cookie is accepted and loads the user', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-1'));
      await service().init();
      expect(service().status()).toBe('authenticated');
      expect(service().user()).toEqual(ME);
      expect(api.me).toHaveBeenCalledWith('jwt-1');
    });

    it('goes anonymous on 401 without redirecting (the guard decides)', async () => {
      api.refresh.mockRejectedValue(problem(401));
      const router = TestBed.inject(Router);
      const navigate = vi.spyOn(router, 'navigateByUrl');
      await service().init();
      expect(service().status()).toBe('anonymous');
      expect(navigate).not.toHaveBeenCalled();
    });

    it.each([
      ['no network', networkProblem()],
      ['404', problem(404)],
      ['503', problem(503)],
      ['429', problem(429, 'rate-limited')],
    ])('goes pending (not anonymous) on %s', async (_label, error) => {
      api.refresh.mockRejectedValue(error);
      await service().init();
      expect(service().status()).toBe('pending');
    });

    it('opens pending when the server is slow and corrects itself when it answers', async () => {
      let answer!: (value: TokenResponse) => void;
      api.refresh.mockReturnValue(new Promise<TokenResponse>((resolve) => (answer = resolve)));
      const done = service().init();
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(service().status()).toBe('pending');

      answer(tokens('jwt-late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service().status()).toBe('authenticated');
    });

    it('is idempotent: a second call shares the first refresh', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      await Promise.all([service().init(), service().init()]);
      expect(api.refresh).toHaveBeenCalledTimes(1);
    });

    it('retries while pending and confirms when the server comes back', async () => {
      api.refresh.mockRejectedValueOnce(networkProblem());
      await service().init();
      expect(service().status()).toBe('pending');
      api.refresh.mockResolvedValue(tokens('jwt'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service().status()).toBe('authenticated');
    });

    it('retries as soon as the device comes back online', async () => {
      api.refresh.mockRejectedValueOnce(networkProblem());
      await service().init();
      api.refresh.mockResolvedValue(tokens('jwt'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service().status()).toBe('authenticated');
    });
  });

  describe('renewal', () => {
    it('schedules the refresh at 80% of the lifetime', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-1', 600));
      await service().init();
      expect(api.refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(479_000);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      api.refresh.mockResolvedValue(tokens('jwt-2', 600));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.refresh).toHaveBeenCalledTimes(2);
    });

    it('renews on return to the tab when the token has less than 60 s left', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-1', 600));
      await service().init();
      // A aba ficou oculta: os timers não rodaram, mas o relógio andou.
      vi.setSystemTime(Date.now() + 560_000);
      api.refresh.mockResolvedValue(tokens('jwt-2', 600));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refresh).toHaveBeenCalledTimes(2);
    });

    it('does not renew on return to the tab when the token is still fresh', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-1', 600));
      await service().init();
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refresh).toHaveBeenCalledTimes(1);
    });

    it('does one renewal at a time: concurrent calls share the refresh', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      await service().init();
      api.refresh.mockClear();
      let inFlight = 0;
      let peak = 0;
      api.refresh.mockImplementation(async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 100));
        inFlight--;
        return tokens('jwt-2');
      });
      const all = Promise.all([service().renew(), service().renew(), service().renew()]);
      await vi.advanceTimersByTimeAsync(200);
      expect(await all).toEqual(['renewed', 'renewed', 'renewed']);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      expect(peak).toBe(1);
    });

    it('takes the cross-tab lock before refreshing', async () => {
      const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
      Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
      api.refresh.mockResolvedValue(tokens('jwt'));
      await service().init();
      expect(request).toHaveBeenCalledWith('uniover-refresh', expect.any(Function));
    });

    it('waits and tries once more after a 409 conflict', async () => {
      api.refresh
        .mockRejectedValueOnce(problem(409, 'refresh-conflict'))
        .mockResolvedValueOnce(tokens('jwt'));
      const done = service().init();
      await vi.advanceTimersByTimeAsync(250);
      await done;
      expect(api.refresh).toHaveBeenCalledTimes(2);
      expect(service().status()).toBe('authenticated');
    });

    it('does not loop on repeated 409: stays pending', async () => {
      api.refresh.mockRejectedValue(problem(409, 'refresh-conflict'));
      const done = service().init();
      await vi.advanceTimersByTimeAsync(250);
      await done;
      expect(api.refresh).toHaveBeenCalledTimes(2);
      expect(service().status()).toBe('pending');
    });

    it('refresh reuse (401 after being authenticated) drops to anonymous and goes to sign-in with next', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      await service().init();
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/tv');

      api.refresh.mockRejectedValue(problem(401));
      expect(await service().renew()).toBe('unauthenticated');
      await vi.advanceTimersByTimeAsync(0);
      expect(service().status()).toBe('anonymous');
      expect(session().bearer()).toBeNull();
      expect(router.url).toBe('/entrar?next=%2Ftv');
    });
  });

  describe('login and logout', () => {
    it('login stores the session in memory only', async () => {
      api.login.mockResolvedValue(tokens('eyJ.secret.token'));
      await service().login('dono@exemplo.com', 'senha');
      expect(service().status()).toBe('authenticated');
      expect(session().bearer()).toBe('eyJ.secret.token');
      const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      expect(stored).not.toContain('eyJ');
    });

    it('signInWithTokens opens the session of an entry done elsewhere (the QR confirmed on the phone), in memory only', async () => {
      await service().signInWithTokens(tokens('eyJ.do-qr.token'));
      expect(service().status()).toBe('authenticated');
      expect(session().bearer()).toBe('eyJ.do-qr.token');
      expect(api.me).toHaveBeenCalledWith('eyJ.do-qr.token');
      expect(api.login).not.toHaveBeenCalled();
      const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      expect(stored).not.toContain('eyJ');
      // Renovação agendada como em qualquer entrada: pouco antes de o token vencer o refresh é chamado.
      api.refresh.mockResolvedValue(tokens('renovado'));
      await vi.advanceTimersByTimeAsync(600 * 1000 * 0.8 + 1000);
      expect(api.refresh).toHaveBeenCalled();
    });

    it('login lets the API problem reach the caller', async () => {
      api.login.mockRejectedValue(problem(401));
      await expect(service().login('a@b.c', 'x')).rejects.toBeInstanceOf(ApiProblem);
      expect(service().status()).toBe('unknown');
    });

    it('logout calls the API, clears memory and leaves local data alone', async () => {
      localStorage.setItem(MODULE_PREFS_KEY, '[{"id":"tv","size":"small","enabled":true}]');
      await dbPut('pendente');
      api.login.mockResolvedValue(tokens('jwt'));
      await service().login('a@b.c', 'x');

      expect(await service().logout()).toBe(true);
      expect(api.logout).toHaveBeenCalledWith('jwt');
      expect(service().status()).toBe('anonymous');
      expect(session().bearer()).toBeNull();
      expect(service().user()).toBeNull();
      expect(localStorage.getItem(MODULE_PREFS_KEY)).not.toBeNull();
      expect(await dbGet()).toBe('pendente');
    });

    it('a renewal that comes back after logout does not bring the session back', async () => {
      api.login.mockResolvedValue(tokens('jwt'));
      await service().login('a@b.c', 'x');
      let finish!: (value: TokenResponse) => void;
      api.refresh.mockReturnValue(new Promise<TokenResponse>((resolve) => (finish = resolve)));

      const renewing = service().renew();
      await service().logout();
      finish(tokens('late-token'));

      expect(await renewing).toBe('unauthenticated');
      expect(service().status()).toBe('anonymous');
      expect(session().bearer()).toBeNull();
    });

    it('a renewal refused after logout does not touch the new state either', async () => {
      api.login.mockResolvedValue(tokens('jwt'));
      await service().login('a@b.c', 'x');
      let fail!: (reason: unknown) => void;
      api.refresh.mockReturnValue(new Promise<TokenResponse>((_, reject) => (fail = reject)));

      const renewing = service().renew();
      await service().logout();
      fail(problem(401));

      expect(await renewing).toBe('unauthenticated');
      expect(service().status()).toBe('anonymous');
    });

    it('logout without a server answer still clears memory and reports it', async () => {
      api.login.mockResolvedValue(tokens('jwt'));
      await service().login('a@b.c', 'x');
      api.logout.mockRejectedValue(networkProblem());
      expect(await service().logout()).toBe(false);
      expect(service().status()).toBe('anonymous');
    });
  });

  describe('name and first access', () => {
    const UNCONFIRMED = {
      ...ME,
      role: 'guest',
      displayNameConfirmed: false,
      permissions: ['module:tv', 'tv:control'],
    };

    it('keeps whether the name was chosen and the permissions the API reported', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      api.me.mockResolvedValue(UNCONFIRMED);
      await service().init();
      expect(session().needsWelcome()).toBe(true);
      expect(session().permissions()).toEqual(['module:tv', 'tv:control']);
    });

    it('saving the name sends the token, replaces the user and clears the pending question', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      api.me.mockResolvedValue(UNCONFIRMED);
      await service().init();
      api.updateMe.mockResolvedValue({
        ...UNCONFIRMED,
        displayName: 'Ana',
        displayNameConfirmed: true,
      });
      await service().updateDisplayName('Ana');
      expect(api.updateMe).toHaveBeenCalledWith('jwt', 'Ana');
      expect(service().user()?.displayName).toBe('Ana');
      expect(session().needsWelcome()).toBe(false);
    });

    it('lets the failure reach the caller and keeps the name and the question as they were', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      api.me.mockResolvedValue(UNCONFIRMED);
      await service().init();
      api.updateMe.mockRejectedValue(problem(400));
      await expect(service().updateDisplayName('')).rejects.toBeInstanceOf(ApiProblem);
      expect(service().user()?.displayName).toBe('Dono');
      expect(session().needsWelcome()).toBe(true);
    });

    it('never asks the passkey for the name (a plain write of the own profile)', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      await service().init();
      api.updateMe.mockRejectedValue(stepUpProblem());
      await expect(service().updateDisplayName('Ana')).rejects.toBeInstanceOf(ApiProblem);
      expect(stepUp.confirm).not.toHaveBeenCalled();
    });

    it('ensureUser reads the user again when the first read after sign-in failed', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      api.me.mockRejectedValueOnce(networkProblem());
      await service().init();
      expect(service().user()).toBeNull();
      api.me.mockResolvedValue(UNCONFIRMED);
      await service().ensureUser();
      expect(service().user()?.displayNameConfirmed).toBe(false);
    });

    it('ensureUser does not call the API when the user is already known or there is no session', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      await service().init();
      api.me.mockClear();
      await service().ensureUser();
      expect(api.me).not.toHaveBeenCalled();

      session().clear('anonymous');
      await service().ensureUser();
      expect(api.me).not.toHaveBeenCalled();
    });

    it('ensureUser swallows a second failure (a bad network never traps anyone)', async () => {
      api.refresh.mockResolvedValue(tokens('jwt'));
      api.me.mockRejectedValue(networkProblem());
      await service().init();
      await expect(service().ensureUser()).resolves.toBeUndefined();
      expect(service().user()).toBeNull();
    });

    it('builds the first-access address with a safe next, and without one for the home page or an unsafe path', () => {
      const router = TestBed.inject(Router);
      expect(router.serializeUrl(service().welcomeUrlTree('/tv?painel=apps'))).toBe(
        '/boas-vindas?next=%2Ftv%3Fpainel%3Dapps',
      );
      expect(router.serializeUrl(service().welcomeUrlTree('/'))).toBe('/boas-vindas');
      expect(router.serializeUrl(service().welcomeUrlTree('//evil.example'))).toBe('/boas-vindas');
      expect(router.serializeUrl(service().welcomeUrlTree('/boas-vindas'))).toBe('/boas-vindas');
    });
  });

  describe('unauthorized answers never erase local data', () => {
    it('a 401 from refresh keeps the module preferences and the offline records', async () => {
      localStorage.setItem(MODULE_PREFS_KEY, '[{"id":"tv","size":"wide","enabled":false}]');
      await dbPut('na-fila');
      api.refresh.mockRejectedValue(problem(401));
      await service().init();
      expect(service().status()).toBe('anonymous');
      expect(localStorage.getItem(MODULE_PREFS_KEY)).toContain('wide');
      expect(await dbGet()).toBe('na-fila');
    });

    it('being offline keeps everything and stays pending', async () => {
      localStorage.setItem(MODULE_PREFS_KEY, '[]');
      await dbPut('na-fila');
      api.refresh.mockRejectedValue(networkProblem());
      await service().init();
      expect(service().status()).toBe('pending');
      expect(await dbGet()).toBe('na-fila');
    });
  });

  describe('authorized', () => {
    beforeEach(async () => {
      api.refresh.mockResolvedValue(tokens('jwt-1'));
      await service().init();
      api.refresh.mockReset();
    });

    it('sends the call with the current token', async () => {
      const call = vi.fn().mockResolvedValue('ok');
      expect(await service().authorized(call)).toBe('ok');
      expect(call).toHaveBeenCalledWith('jwt-1');
    });

    it('renews once on 401 and repeats once', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-2'));
      const call = vi.fn().mockRejectedValueOnce(problem(401)).mockResolvedValueOnce('ok');
      expect(await service().authorized(call)).toBe('ok');
      expect(api.refresh).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenNthCalledWith(2, 'jwt-2');
    });

    it('does not loop when the repeated call is 401 again', async () => {
      api.refresh.mockResolvedValue(tokens('jwt-2'));
      const call = vi.fn().mockRejectedValue(problem(401));
      await expect(service().authorized(call)).rejects.toBeInstanceOf(ApiProblem);
      expect(call).toHaveBeenCalledTimes(2);
      expect(api.refresh).toHaveBeenCalledTimes(1);
    });

    it('concurrent 401s produce a single refresh', async () => {
      api.refresh.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return tokens('jwt-2');
      });
      const make = () =>
        vi.fn(async (token: string) => {
          if (token === 'jwt-1') throw problem(401);
          return token;
        });
      const all = Promise.all([service().authorized(make()), service().authorized(make())]);
      await vi.advanceTimersByTimeAsync(100);
      expect(await all).toEqual(['jwt-2', 'jwt-2']);
      expect(api.refresh).toHaveBeenCalledTimes(1);
    });

    it('asks for the passkey on step-up and repeats once', async () => {
      stepUp.confirm.mockResolvedValue(true);
      const call = vi.fn().mockRejectedValueOnce(stepUpProblem()).mockResolvedValueOnce('ok');
      expect(await service().authorized(call)).toBe('ok');
      expect(stepUp.confirm).toHaveBeenCalledWith('a.b');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('does not repeat when the step-up is declined', async () => {
      stepUp.confirm.mockResolvedValue(false);
      const call = vi.fn().mockRejectedValue(stepUpProblem());
      await expect(service().authorized(call)).rejects.toBeInstanceOf(ApiProblem);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not enter a loop when the step-up is still required after confirming', async () => {
      stepUp.confirm.mockResolvedValue(true);
      const call = vi.fn().mockRejectedValue(stepUpProblem());
      await expect(service().authorized(call)).rejects.toBeInstanceOf(ApiProblem);
      expect(call).toHaveBeenCalledTimes(2);
      expect(stepUp.confirm).toHaveBeenCalledTimes(1);
    });

    it('does not start the step-up flow for a wrong password or a spent challenge (also 403)', async () => {
      const wrongPassword = vi.fn().mockRejectedValue(problem(403, 'invalid-password'));
      await expect(service().authorized(wrongPassword)).rejects.toBeInstanceOf(ApiProblem);
      const spent = vi.fn().mockRejectedValue(problem(403, 'step-up-failed'));
      await expect(service().authorized(spent)).rejects.toBeInstanceOf(ApiProblem);
      expect(stepUp.confirm).not.toHaveBeenCalled();
    });

    it('does not start the step-up flow when asked not to (calls made by the flow itself)', async () => {
      const call = vi.fn().mockRejectedValue(stepUpProblem());
      await expect(service().authorized(call, { stepUp: false })).rejects.toBeInstanceOf(
        ApiProblem,
      );
      expect(stepUp.confirm).not.toHaveBeenCalled();
    });

    it('renews before the call when the token is about to expire', async () => {
      vi.setSystemTime(Date.now() + 550_000);
      api.refresh.mockResolvedValue(tokens('jwt-2'));
      const call = vi.fn().mockResolvedValue('ok');
      await service().authorized(call);
      expect(call).toHaveBeenCalledWith('jwt-2');
    });
  });

  // As permissões vêm de `/me` e o servidor as reavalia a cada 30 s: a tela precisa se corrigir sozinha, sem recarregar,
  // com leituras raras (nunca polling curto) e nunca em tempestade.
  describe('account refresh (permissions follow the server)', () => {
    const POWER = ['module:tv', 'tv:control', 'tv:power'];
    const NO_POWER = ['module:tv', 'tv:control'];
    const guest = (permissions: string[]) => ({ ...ME, role: 'guest', permissions });
    const forbidden = () => problem(403, 'forbidden');

    beforeEach(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      api.me.mockResolvedValue(guest(POWER));
      api.refresh.mockResolvedValue(tokens('jwt-1', 600));
      await service().init();
      api.me.mockClear();
    });

    afterEach(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    const comeBack = async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await advance(0);
    };
    /** Uma chamada que a API recusa por falta de acesso: o erro sobe, e a leitura da conta segue em segundo plano. */
    const denied = async () => {
      await expect(service().authorized(() => Promise.reject(forbidden()))).rejects.toBeInstanceOf(
        ApiProblem,
      );
      await advance(0);
    };

    describe('on renewal', () => {
      it('re-reads the account with the new token and the permissions follow', async () => {
        api.me.mockResolvedValue(guest(NO_POWER));
        api.refresh.mockResolvedValue(tokens('jwt-2', 600));
        await advance(481_000);
        expect(api.refresh).toHaveBeenCalledTimes(2);
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(api.me).toHaveBeenCalledWith('jwt-2');
        expect(session().permissions()).toEqual(NO_POWER);
      });

      it('a failed re-read keeps the last permissions and the session', async () => {
        api.me.mockRejectedValue(networkProblem());
        await advance(481_000);
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(service().status()).toBe('authenticated');
        expect(session().permissions()).toEqual(POWER);
      });

      it('does not make the renewal wait for the re-read (a user is already loaded)', async () => {
        api.me.mockReturnValue(new Promise(() => undefined));
        api.refresh.mockResolvedValue(tokens('jwt-2', 600));
        expect(await service().renew()).toBe('renewed');
      });
    });

    describe('on return to the tab', () => {
      it('does not read again within 30 s of the last read', async () => {
        await advance(29_000);
        await comeBack();
        expect(api.me).not.toHaveBeenCalled();
      });

      it('reads once after 30 s, the permissions follow and the ceiling restarts from that read', async () => {
        api.me.mockResolvedValue(guest(NO_POWER));
        await advance(30_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toEqual(NO_POWER);

        await advance(20_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(1);
        await advance(10_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(2);
      });

      it('also reads on a page restored from the back-forward cache, but not on a plain pageshow', async () => {
        await advance(31_000);
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
        await advance(0);
        expect(api.me).not.toHaveBeenCalled();
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        await advance(0);
        expect(api.me).toHaveBeenCalledTimes(1);
      });

      it('does nothing while the tab is hidden or when there is no session', async () => {
        await advance(31_000);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        await comeBack();
        expect(api.me).not.toHaveBeenCalled();

        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        session().clear('anonymous');
        await comeBack();
        expect(api.me).not.toHaveBeenCalled();
      });

      it('leaves the renewal to do the reading when the token is about to expire', async () => {
        api.me.mockResolvedValue(guest(NO_POWER));
        api.refresh.mockResolvedValue(tokens('jwt-2', 600));
        await advance(31_000);
        vi.setSystemTime(Date.now() + 520_000);
        await comeBack();
        expect(api.refresh).toHaveBeenCalledTimes(2);
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toEqual(NO_POWER);
      });

      it('a failed read keeps the permissions, and the failed try counts for the ceiling', async () => {
        api.me.mockRejectedValueOnce(networkProblem()).mockResolvedValue(guest(NO_POWER));
        await advance(31_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toEqual(POWER);
        expect(service().status()).toBe('authenticated');

        await advance(10_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(1);
        await advance(20_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(2);
        expect(session().permissions()).toEqual(NO_POWER);
      });
    });

    describe('on a 403 of access', () => {
      it('re-reads the account once, the permissions follow and the call still fails', async () => {
        api.me.mockResolvedValue(guest(NO_POWER));
        await advance(6_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toEqual(NO_POWER);
      });

      it('does not read when the last read was less than 5 s ago', async () => {
        await advance(4_000);
        await denied();
        expect(api.me).not.toHaveBeenCalled();
      });

      it('repeated 403s with an unchanged answer fall back to the 30 s ceiling (no storm)', async () => {
        await advance(6_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);

        await denied();
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);
        await advance(10_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);

        await advance(20_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(2);
      });

      it('after a 403 whose read did bring a change, the next 403 can read again after 5 s', async () => {
        api.me.mockResolvedValueOnce(guest(NO_POWER)).mockResolvedValue(guest(['module:tv']));
        await advance(6_000);
        await denied();
        await advance(6_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(2);
        expect(session().permissions()).toEqual(['module:tv']);
      });

      it('ignores the 403 of the passkey, of a wrong password and of other typed refusals, and any other error', async () => {
        await advance(6_000);
        stepUp.confirm.mockResolvedValue(false);
        for (const error of [
          stepUpProblem(),
          problem(403, 'invalid-password'),
          problem(403, 'step-up-failed'),
          problem(404, 'not-found'),
          problem(500),
          networkProblem(),
        ]) {
          await expect(service().authorized(() => Promise.reject(error))).rejects.toBeInstanceOf(
            ApiProblem,
          );
        }
        await advance(0);
        expect(api.me).not.toHaveBeenCalled();
      });

      it('never reads for the administrator, who already has everything', async () => {
        session().setUser({ ...ME, role: 'owner' });
        await advance(6_000);
        await denied();
        expect(api.me).not.toHaveBeenCalled();
      });

      it('does not trigger itself: a 403 on the read of the account itself is not read again', async () => {
        api.me.mockRejectedValue(forbidden());
        await advance(6_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);
        // Leitura sem resposta útil também não é mudança: o próximo 403 espera o teto de 30 s.
        await advance(10_000);
        await denied();
        expect(api.me).toHaveBeenCalledTimes(1);
        await advance(30_000);
        await denied();
        // Uma leitura por 403 que passou do teto; as duas falharam com 403 e nenhuma gerou outra.
        expect(api.me).toHaveBeenCalledTimes(2);
      });

      it('a 401 on the read after a 403 follows the normal expired-session flow', async () => {
        const router = TestBed.inject(Router);
        await router.navigateByUrl('/tv');
        api.me.mockRejectedValue(problem(401));
        api.refresh.mockRejectedValue(problem(401));
        await advance(6_000);
        await denied();
        await advance(0);
        expect(service().status()).toBe('anonymous');
        expect(session().bearer()).toBeNull();
        expect(router.url).toBe('/entrar?next=%2Ftv');
      });
    });

    describe('every trigger goes through the same read', () => {
      it('simultaneous triggers share one read in flight', async () => {
        let answer!: (me: unknown) => void;
        api.me.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        await advance(31_000);
        const all = Promise.all([
          service().refreshUser('foreground'),
          service().refreshUser('forbidden'),
          service().refreshUser('renewal'),
          service().refreshUser('foreground'),
        ]);
        await advance(0);
        answer(guest(NO_POWER));
        await all;
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toEqual(NO_POWER);
      });

      it('an answer with the same permissions (new list, other order) changes nothing readers see', async () => {
        const permissions = session().permissions();
        const user = session().user();
        api.me.mockResolvedValue(guest([...POWER].reverse()));
        await advance(31_000);
        await comeBack();
        expect(api.me).toHaveBeenCalledTimes(1);
        expect(session().permissions()).toBe(permissions);
        expect(session().user()).toBe(user);
      });

      it('discards an answer that arrives after the session ended', async () => {
        let answer!: (me: unknown) => void;
        api.me.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        await advance(31_000);
        const read = service().refreshUser('foreground');
        await advance(0);
        await service().logout();
        answer(guest(NO_POWER));
        await read;
        expect(service().user()).toBeNull();
        expect(service().status()).toBe('anonymous');
      });

      it('keeps the permissions in the browser storage only as the hint of the last session', async () => {
        await advance(31_000);
        await comeBack();
        const { 'uniover.account-permissions': hint, ...rest } = { ...localStorage };
        expect(hint).toContain('tv:power');
        expect(JSON.stringify(rest) + JSON.stringify({ ...sessionStorage })).not.toContain(
          'tv:power',
        );
      });
    });
  });
});
