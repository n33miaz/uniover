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
      },
      {
        id: 'tv-2',
        name: 'Sala',
        isDefault: true,
        agentSlug: null,
        kind: null,
        online: true,
        capabilities: ['tv.remote'],
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
