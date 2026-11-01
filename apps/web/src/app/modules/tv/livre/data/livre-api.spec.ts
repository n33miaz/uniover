import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../../core/session/session-state';
import { TvSelection } from '../../data/tv-selection';
import { makeTv } from '../../tv-test-kit';
import { TvLivreApi } from './livre-api';
import { DEFAULT_LIVRE_CONFIG } from './livre-types';

const VIEW = {
  available: true,
  supported: true,
  installed: true,
  version: '1.0.0',
  isHome: false,
  factoryLauncher: null,
  disabledPackages: [],
  apps: [{ package: 'com.exemplo.app', factory: false, disabled: false }],
  stateAt: '2026-10-31T12:00:00Z',
  config: DEFAULT_LIVRE_CONFIG,
  hasPhoto: false,
  revision: 3,
};

describe('TvLivreApi', () => {
  let api: TvLivreApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(TvLivreApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('reads the state and turns it into a view', async () => {
    const view = api.get();
    const request = http.expectOne('/api/v1/tv/livre');
    expect(request.request.method).toBe('GET');
    request.flush(VIEW);
    expect((await view).version).toBe('1.0.0');
  });

  it('refuses a body that is not a view', async () => {
    const view = api.get();
    http.expectOne('/api/v1/tv/livre').flush({ nada: true });
    await expect(view).rejects.toThrow('formato inesperado');
  });

  it('asks the agent for the state, saves the config and applies it, each one on its own route', async () => {
    const refresh = api.refresh();
    const first = http.expectOne('/api/v1/tv/livre/refresh');
    expect(first.request.method).toBe('POST');
    first.flush(VIEW);
    await refresh;

    const save = api.saveConfig(DEFAULT_LIVRE_CONFIG);
    const put = http.expectOne('/api/v1/tv/livre/config');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual(DEFAULT_LIVRE_CONFIG);
    put.flush(VIEW);
    await save;

    const apply = api.apply();
    const post = http.expectOne('/api/v1/tv/livre/apply');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toBeNull();
    post.flush({ ...VIEW, revision: 4 });
    expect((await apply).revision).toBe(4);
  });

  it('installs, sets as home with the choice about the factory launcher, and restores', async () => {
    const install = api.install();
    http.expectOne('/api/v1/tv/livre/install').flush(VIEW);
    await install;

    const home = api.setHome(true);
    const setHome = http.expectOne('/api/v1/tv/livre/set-home');
    expect(setHome.request.body).toEqual({ disableFactory: true });
    setHome.flush(VIEW);
    await home;

    const restore = api.restore();
    const request = http.expectOne('/api/v1/tv/livre/restore');
    expect(request.request.body).toEqual({ uninstall: true });
    request.flush(VIEW);
    await restore;
  });

  it('puts the sleep command without a body and expects nothing back', async () => {
    const sleep = api.sleep();
    const request = http.expectOne('/api/v1/tv/livre/sleep');
    expect(request.request.method).toBe('POST');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(sleep).resolves.toBeUndefined();
  });

  it('sends the photo as image/jpeg bytes', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    const put = api.putPhoto(jpeg);
    const request = http.expectOne('/api/v1/tv/livre/photo');
    expect(request.request.method).toBe('PUT');
    expect(request.request.headers.get('Content-Type')).toBe('image/jpeg');
    expect(request.request.body).toBe(jpeg);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await put;
  });

  it('reads the photo as a blob, and a 404 means there is none', async () => {
    const photo = api.photo();
    const request = http.expectOne('/api/v1/tv/livre/photo');
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['x'], { type: 'image/jpeg' }));
    expect((await photo)?.size).toBe(1);

    const none = api.photo();
    http.expectOne('/api/v1/tv/livre/photo').flush(null, { status: 404, statusText: 'Not Found' });
    expect(await none).toBeNull();
  });

  it('does not hide the other errors of the photo', async () => {
    const photo = api.photo();
    http.expectOne('/api/v1/tv/livre/photo').flush(null, { status: 500, statusText: 'x' });
    await expect(photo).rejects.toMatchObject({ status: 500 });
  });

  it('deletes the photo', async () => {
    const removed = api.deletePhoto();
    const request = http.expectOne('/api/v1/tv/livre/photo');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await removed;
  });

  it('adds the chosen TV only when there is more than one', async () => {
    TestBed.inject(SessionState).setUser({
      id: 'conta',
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
    const selection = TestBed.inject(TvSelection);
    selection.setTvs([makeTv('a', { isDefault: true }), makeTv('b')]);
    selection.select('b');
    const view = api.get();
    const request = http.expectOne((req) => req.url === '/api/v1/tv/livre');
    expect(request.request.params.get('tvId')).toBe('b');
    request.flush(VIEW);
    await view;

    selection.setTvs([makeTv('b')]);
    const alone = api.get();
    const second = http.expectOne('/api/v1/tv/livre');
    expect(second.request.params.has('tvId')).toBe(false);
    second.flush(VIEW);
    await alone;
  });
});
