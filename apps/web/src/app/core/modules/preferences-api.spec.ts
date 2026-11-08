import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PreferencesApi } from './preferences-api';

const URL = '/api/v1/identity/me/preferences';
const HINT_URL = '/api/v1/identity/me/install-hint';

describe('PreferencesApi', () => {
  describe('with the HTTP client', () => {
    let api: PreferencesApi;
    let http: HttpTestingController;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      api = TestBed.inject(PreferencesApi);
      http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('reads the preferences of the account', async () => {
      const done = api.get();
      const request = http.expectOne(URL);
      expect(request.request.method).toBe('GET');
      request.flush({
        version: 2,
        updatedAt: '2026-10-31T12:00:00Z',
        home: [{ id: 'tv', enabled: true }],
      });
      expect(await done).toEqual({
        version: 2,
        updatedAt: '2026-10-31T12:00:00Z',
        home: [{ id: 'tv', enabled: true }],
      });
    });

    it('reads the install hint answers of the account from its own route, dropping anything that is not the expected shape', async () => {
      const done = api.getInstallHint();
      const request = http.expectOne(HINT_URL);
      expect(request.request.method).toBe('GET');
      request.flush({
        root: { installed: true, dismissedAt: 5, extra: 'x' },
        tv: { never: 'sim', dismissedAt: 'ontem' },
        treino: 'texto',
      });
      expect(await done).toEqual({
        root: { installed: true, dismissedAt: 5, never: undefined },
        tv: { installed: undefined, dismissedAt: undefined, never: undefined },
      });
    });

    it('an account that never answered reads an empty object, and a body that is not an object fails', async () => {
      const empty = api.getInstallHint();
      http.expectOne(HINT_URL).flush({});
      expect(await empty).toEqual({});

      const bad = api.getInstallHint();
      http.expectOne(HINT_URL).flush([1, 2]);
      await expect(bad).rejects.toThrow();
    });

    it('does not touch the preferences route to read the install hint', async () => {
      const done = api.get();
      http.expectOne(URL).flush({ version: 0, updatedAt: null, home: null });
      expect(await done).toEqual({ version: 0, updatedAt: null, home: null });
    });

    it('saves the install hint answer on its own route, without version or home', async () => {
      const done = api.saveInstallHint({ root: { installed: true } });
      const request = http.expectOne(HINT_URL);
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ scopes: { root: { installed: true } } });
      request.flush({ root: { installed: true }, tv: { never: true } });
      expect(await done).toEqual({
        root: { installed: true, dismissedAt: undefined, never: undefined },
        tv: { never: true, dismissedAt: undefined, installed: undefined },
      });
    });

    it('fails the install hint save on a refusal, so the caller can keep the answer local', async () => {
      const done = api.saveInstallHint({ root: { installed: true } });
      http.expectOne(HINT_URL).flush({ title: 'x' }, { status: 403, statusText: 'Forbidden' });
      await expect(done).rejects.toBeDefined();
    });

    it('rejects an answer that does not look like preferences', async () => {
      const done = api.get();
      http.expectOne(URL).flush({ outra: 'coisa' });
      await expect(done).rejects.toThrow();
    });

    it('saves the whole list over the version it read, sending only id and visibility', async () => {
      const done = api.save(2, [{ id: 'tv', enabled: false }]);
      const request = http.expectOne(URL);
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({
        baseVersion: 2,
        home: [{ id: 'tv', enabled: false }],
      });
      request.flush({ version: 3, updatedAt: null, home: [{ id: 'tv', enabled: false }] });
      expect(await done).toEqual({
        saved: true,
        current: { version: 3, updatedAt: null, home: [{ id: 'tv', enabled: false }] },
      });
    });

    it('sends a null list to go back to the default', async () => {
      const done = api.save(1, null);
      const request = http.expectOne(URL);
      expect(request.request.body).toEqual({ baseVersion: 1, home: null });
      request.flush({ version: 2, updatedAt: null, home: null });
      expect((await done).saved).toBe(true);
    });

    it('turns a 409 into "not saved" carrying the account as it is now', async () => {
      const done = api.save(1, [{ id: 'tv', enabled: true }]);
      http.expectOne(URL).flush(
        {
          version: 4,
          updatedAt: '2026-10-31T13:00:00Z',
          home: [{ id: 'training', enabled: true }],
        },
        { status: 409, statusText: 'Conflict' },
      );
      expect(await done).toEqual({
        saved: false,
        current: {
          version: 4,
          updatedAt: '2026-10-31T13:00:00Z',
          home: [{ id: 'training', enabled: true }],
        },
      });
    });

    it.each([400, 401, 403, 429, 500])(
      'throws on a %s (only a version mismatch is a normal outcome)',
      async (status) => {
        const done = api.save(1, [{ id: 'tv', enabled: true }]);
        http.expectOne(URL).flush({ title: 'x' }, { status, statusText: 'Erro' });
        await expect(done).rejects.toBeDefined();
      },
    );

    it('throws on a 409 whose body is not preferences', async () => {
      const done = api.save(1, [{ id: 'tv', enabled: true }]);
      http.expectOne(URL).flush({ title: 'em andamento' }, { status: 409, statusText: 'Conflict' });
      await expect(done).rejects.toBeDefined();
    });
  });

  it('fails like an offline call when the screen has no HTTP client, so the app keeps the local copy', async () => {
    TestBed.configureTestingModule({});
    const api = TestBed.inject(PreferencesApi);
    await expect(api.get()).rejects.toThrow();
    await expect(api.save(0, null)).rejects.toThrow();
    await expect(api.saveInstallHint({ root: { installed: true } })).rejects.toThrow();
    await expect(api.getInstallHint()).rejects.toThrow();
  });
});
