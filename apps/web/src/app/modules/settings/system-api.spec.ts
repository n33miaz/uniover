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

  it('binds the computer with a JSON body carrying only the chosen one', async () => {
    const done = api.bindTvComputer('pc-novo');
    const request = http.expectOne('/api/v1/tv/config/agent');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ agentSlug: 'pc-novo', name: null });
    request.flush({ ...CONFIG, agentSlug: 'pc-novo' });
    expect((await done).agentSlug).toBe('pc-novo');
  });
});
