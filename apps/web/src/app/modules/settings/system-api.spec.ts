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

  it('reads the deployed version from /health/version at the server root, not under /api', async () => {
    const result = api.deploymentVersion();
    const request = http.expectOne('/health/version');
    expect(request.request.method).toBe('GET');
    request.flush({ commit: 'abc1234', version: '0.32.0' });
    await expect(result).resolves.toEqual({ commit: 'abc1234', version: '0.32.0' });
  });

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

  it('reads the dead letters and tolerates missing fields', async () => {
    const read = api.deadLetters();
    const request = http.expectOne('/api/v1/system/dead-letters');
    expect(request.request.method).toBe('GET');
    request.flush({
      total: 2,
      items: [
        {
          module: 'devices',
          id: 'e-1',
          type: 'devices.agent-revoked.v1',
          failedAt: '2026-10-31T12:00:00Z',
          attempts: 8,
          lastError: null,
        },
      ],
    });
    const report = await read;
    expect(report.total).toBe(2);
    expect(report.items).toHaveLength(1);
    expect(report.unavailableModules).toEqual([]);
  });

  it('reads which TV still needs the permission accept', async () => {
    const read = api.tvs();
    http.expectOne('/api/v1/tv/tvs').flush({
      items: [
        { ...TV, permissionNeeded: true },
        { ...TV, id: 'tv-3', permissionNeeded: false },
      ],
    });
    const [needs, fine] = await read;
    expect(needs.permissionNeeded).toBe(true);
    expect(fine.permissionNeeded).toBeUndefined();
  });

  it('asks the computer for the TVs it found on its network, keeping only valid ones', async () => {
    const read = api.nearbyTvs('pc-casa');
    const request = http.expectOne('/api/v1/tv/tvs/nearby?agent=pc-casa');
    expect(request.request.method).toBe('GET');
    request.flush({
      status: 'ok',
      items: [
        { id: 'a1b2c3d4e5f60718', kind: 'samsung', name: 'Sala', controlled: true },
        { id: 'f0e1d2c3b4a59687', kind: 'android', name: null, controlled: false },
        { id: 'x', kind: 'roku', name: 'Outra', controlled: false },
        { kind: 'samsung' },
        null,
      ],
    });
    expect(await read).toEqual({
      status: 'ok',
      items: [
        { id: 'a1b2c3d4e5f60718', kind: 'samsung', name: 'Sala', controlled: true },
        { id: 'f0e1d2c3b4a59687', kind: 'android', name: null, controlled: false },
      ],
    });
  });

  it.each(['offline', 'unsupported', 'busy'])(
    'passes the %s status of the search on',
    async (status) => {
      const read = api.nearbyTvs('pc-casa');
      http.expectOne('/api/v1/tv/tvs/nearby?agent=pc-casa').flush({ status, items: [] });
      expect(await read).toEqual({ status, items: [] });
    },
  );

  it('treats an unknown status of the search as a failure', async () => {
    const read = api.nearbyTvs('pc-casa');
    http.expectOne('/api/v1/tv/tvs/nearby?agent=pc-casa').flush({ status: 'estranho' });
    expect(await read).toEqual({ status: 'failed', items: [] });
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

  it('reads what the agents reported about themselves, asking for the newest 50 by default', async () => {
    const read = api.agentDiagnostics();
    const request = http.expectOne('/api/v1/devices/agents/diagnostics?limit=50');
    expect(request.request.method).toBe('GET');
    request.flush({
      retentionDays: 7,
      items: [
        {
          id: 'e1',
          agentId: 'a1',
          agentName: 'PC da sala',
          at: '2026-10-31T12:00:00Z',
          kind: 'background.failed',
          severity: 'error',
          component: 'tv.session',
          detail: 'TimeoutError',
          count: 3,
        },
      ],
    });
    const result = await read;
    expect(result.retentionDays).toBe(7);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ severity: 'error', count: 3, component: 'tv.session' });
  });

  it('refuses a diagnostics list in an unexpected format', async () => {
    const read = api.agentDiagnostics(10);
    http.expectOne('/api/v1/devices/agents/diagnostics?limit=10').flush({});
    await expect(read).rejects.toThrow();
  });

  it('reads the focus mode catalog of a TV', async () => {
    const read = api.tvFocusCatalog('tv-2');
    const request = http.expectOne('/api/v1/tv/tvs/tv-2/focus-catalog');
    expect(request.request.method).toBe('GET');
    request.flush({ packages: ['com.a.b'], defaults: ['com.c.d', 'com.a.b'], isCustom: true });
    expect(await read).toEqual({
      packages: ['com.a.b'],
      defaults: ['com.c.d', 'com.a.b'],
      isCustom: true,
    });
  });

  it('refuses a focus catalog in an unexpected format', async () => {
    const read = api.tvFocusCatalog('tv-2');
    http.expectOne('/api/v1/tv/tvs/tv-2/focus-catalog').flush({ packages: 'x' });
    await expect(read).rejects.toThrow();
  });

  it('sends the focus catalog on the update only when it is given', async () => {
    const withCatalog = api.updateTv('tv-2', { focusPackages: ['com.a.b'] });
    const patch = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ focusPackages: ['com.a.b'] });
    patch.flush({ ...TV, id: 'tv-2' });
    await withCatalog;

    const without = api.updateTv('tv-2', { name: 'Quarto' });
    const second = http.expectOne('/api/v1/tv/tvs/tv-2');
    expect(second.request.body).toEqual({ name: 'Quarto' });
    second.flush({ ...TV, id: 'tv-2' });
    await without;
  });

  it('reads the history of a TV by its id and keeps only well-formed rows', async () => {
    const read = api.tvHistory('tv-2', 20);
    const request = http.expectOne((r) => r.url === '/api/v1/tv/commands/recent');
    expect(request.request.params.get('tvId')).toBe('tv-2');
    expect(request.request.params.get('limit')).toBe('20');
    request.flush([
      {
        id: 'h1',
        userId: 'u1',
        command: 'tv.key',
        detail: 'HOME/SHORT',
        ok: true,
        errorCode: null,
        occurredAt: '2026-10-31T20:00:00Z',
        byMe: false,
      },
      { id: 'sem-usuario', command: 'tv.key', occurredAt: '2026-10-31T20:00:00Z' },
    ]);
    expect(await read).toEqual([
      {
        id: 'h1',
        userId: 'u1',
        command: 'tv.key',
        detail: 'HOME/SHORT',
        ok: true,
        errorCode: null,
        occurredAt: '2026-10-31T20:00:00Z',
      },
    ]);
  });

  it('refuses a history that is not a list', async () => {
    const read = api.tvHistory('tv-2');
    http.expectOne((r) => r.url === '/api/v1/tv/commands/recent').flush({});
    await expect(read).rejects.toThrow();
  });

  it('asks for the TVs of each person with one repeated parameter, and asks nothing for nobody', async () => {
    await expect(api.tvAccess([])).resolves.toEqual([]);

    const read = api.tvAccess(['u1', 'u2']);
    const request = http.expectOne((r) => r.url === '/api/v1/tv/tvs/access');
    expect(request.request.params.getAll('userId')).toEqual(['u1', 'u2']);
    request.flush({ items: [{ userId: 'u1', tvIds: ['tv-1'] }, { userId: 'u2', tvIds: [] }, {}] });
    expect(await read).toEqual([
      { userId: 'u1', tvIds: ['tv-1'] },
      { userId: 'u2', tvIds: [] },
    ]);
  });

  it('reads the deployed version from the health route, outside the versioned API prefix', async () => {
    const read = api.deploymentVersion();
    const request = http.expectOne('/health/version');
    expect(request.request.method).toBe('GET');
    request.flush({ commit: 'abc', version: '0.33.0' });
    expect(await read).toEqual({ commit: 'abc', version: '0.33.0' });
  });
});
