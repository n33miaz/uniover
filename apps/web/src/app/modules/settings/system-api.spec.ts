import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SystemApi, TvConfig } from './system-api';

const CONFIG: TvConfig = {
  name: 'TV',
  agentSlug: 'pc-casa',
  agentName: 'PC de casa',
  source: 'saved',
  agentStatus: 'online',
  agents: [{ slug: 'pc-casa', name: 'PC de casa', platform: 'windows', online: true }],
};

const TV = {
  id: 'tv-1',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote'],
};

describe('SystemApi', () => {
  let api: SystemApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(SystemApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the TV configuration', async () => {
    const read = api.tvConfig();
    const request = http.expectOne('/api/v1/tv/config');
    expect(request.request.method).toBe('GET');
    request.flush(CONFIG);
    expect(await read).toEqual(CONFIG);
  });

  it('restores a system setting to its server default', async () => {
    const restored = api.resetSystemSetting('tv.light-cleanup-enabled');
    const request = http.expectOne('/api/v1/identity/system-settings/tv.light-cleanup-enabled');
    expect(request.request.method).toBe('DELETE');
    request.flush({ key: 'tv.light-cleanup-enabled', value: true, source: 'server' });
    expect(await restored).toEqual({
      key: 'tv.light-cleanup-enabled',
      value: true,
      source: 'server',
    });
  });

  it('lists the TVs, keeping what the administrator needs and dropping the rest', async () => {
    const read = api.tvs();
    const request = http.expectOne('/api/v1/tv/tvs');
    expect(request.request.method).toBe('GET');
    request.flush({
      items: [TV, { name: 'sem id' }, { ...TV, id: 'tv-2', kind: 'roku', agentSlug: null }],
    });
    expect(await read).toEqual([
      {
        id: 'tv-1',
        name: 'Sala',
        isDefault: true,
        agentSlug: 'pc-casa',
        kind: 'android',
        online: true,
        capabilities: ['tv.remote'],
        allowBackgroundAppClosing: false,
      },
      {
        id: 'tv-2',
        name: 'Sala',
        isDefault: true,
        agentSlug: null,
        kind: null,
        online: true,
        capabilities: ['tv.remote'],
        allowBackgroundAppClosing: false,
      },
    ]);
  });

  it('refuses a list that is not in the expected format', async () => {
    const read = api.tvs();
    http.expectOne('/api/v1/tv/tvs').flush({ itens: [] });
    await expect(read).rejects.toThrow();
  });

  it('creates a TV with the computer and the name', async () => {
    const created = api.createTv('pc-amigo', 'Raphael');
    const request = http.expectOne('/api/v1/tv/tvs');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ agentSlug: 'pc-amigo', name: 'Raphael' });
    request.flush({ ...TV, id: 'tv-2', name: 'Raphael', isDefault: false, kind: 'samsung' });
    expect((await created).id).toBe('tv-2');
  });

  it('changes only what was given', async () => {
    const rename = api.updateTv('tv-2', { name: 'Quarto' });
    const first = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(first.request.method).toBe('PATCH');
    expect(first.request.body).toEqual({ name: 'Quarto' });
    first.flush({ ...TV, id: 'tv-2', name: 'Quarto' });
    expect((await rename).name).toBe('Quarto');

    const rebind = api.updateTv('tv-2', { agentSlug: 'pc-novo' });
    const second = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(second.request.body).toEqual({ agentSlug: 'pc-novo' });
    second.flush({ ...TV, id: 'tv-2' });
    await rebind;
  });

  it('reads the background app closing option as off unless the API says on', async () => {
    const read = api.tvs();
    http.expectOne('/api/v1/tv/tvs').flush({
      items: [TV, { ...TV, id: 'tv-2', allowBackgroundAppClosing: true }],
    });
    expect((await read).map((tv) => tv.allowBackgroundAppClosing)).toEqual([false, true]);
  });

  it('sends the background app closing option on its own', async () => {
    const change = api.updateTv('tv-2', { allowBackgroundAppClosing: true });
    const request = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ allowBackgroundAppClosing: true });
    request.flush({ ...TV, id: 'tv-2', allowBackgroundAppClosing: true });
    expect((await change).allowBackgroundAppClosing).toBe(true);
  });

  it('sends the reversible light settings together with the selected apps', async () => {
    const change = api.updateTv('tv-2', {
      focusModeEnabled: true,
      shortAnimationsEnabled: true,
      restrictedBackgroundPackages: ['com.example.video'],
    });
    const request = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(request.request.body).toEqual({
      focusModeEnabled: true,
      shortAnimationsEnabled: true,
      restrictedBackgroundPackages: ['com.example.video'],
    });
    request.flush({ ...TV, id: 'tv-2', focusModeEnabled: true });
    expect((await change).focusModeEnabled).toBe(true);
  });

  it('sends and reads back whether the focus mode closes the other apps', async () => {
    const change = api.updateTv('tv-2', { focusModeEnabled: true, focusClosesBackground: true });
    const request = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(request.request.body).toEqual({ focusModeEnabled: true, focusClosesBackground: true });
    request.flush({ ...TV, id: 'tv-2', focusModeEnabled: true, focusClosesBackground: true });
    expect((await change).focusClosesBackground).toBe(true);
  });

  it('lists the apps from the inventory of the TV being edited', async () => {
    const read = api.tvApps('tv-2');
    const request = http.expectOne('/api/v1/tv/tvs/tv-2/apps');
    expect(request.request.method).toBe('GET');
    request.flush({ items: [{ package: 'com.example.video', label: 'Vídeo' }] });
    expect(await read).toEqual([{ package: 'com.example.video', label: 'Vídeo' }]);
  });

  it('removes a TV', async () => {
    const removed = api.deleteTv('tv-2');
    const request = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(removed).resolves.toBeUndefined();
  });

  it('reads and replaces the accounts that use a TV, sending the complete list', async () => {
    const read = api.tvMembers('tv-2');
    const get = http.expectOne('/api/v1/tv/tvs/tv-2/members');
    expect(get.request.method).toBe('GET');
    get.flush({ userIds: ['u1', 'u2'] });
    expect(await read).toEqual(['u1', 'u2']);

    const write = api.setTvMembers('tv-2', ['u1']);
    const put = http.expectOne('/api/v1/tv/tvs/tv-2/members');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ userIds: ['u1'] });
    put.flush({ userIds: ['u1'] });
    expect(await write).toEqual(['u1']);
  });

  it('refuses members in an unexpected format', async () => {
    const read = api.tvMembers('tv-2');
    http.expectOne('/api/v1/tv/tvs/tv-2/members').flush({});
    await expect(read).rejects.toThrow();
  });
});
