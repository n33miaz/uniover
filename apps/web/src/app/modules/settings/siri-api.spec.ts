import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SiriApi } from './siri-api';

describe('SiriApi', () => {
  let api: SiriApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(SiriApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the keys and tolerates an answer without items', async () => {
    const first = api.keys();
    http.expectOne('/api/v1/tv/siri/tokens').flush({
      items: [{ id: 'k1', name: 'iPhone', tvId: 't1', tvName: 'Sala', actions: ['mute'] }],
    });
    expect((await first).map((key) => key.id)).toEqual(['k1']);

    const second = api.keys();
    http.expectOne('/api/v1/tv/siri/tokens').flush({});
    expect(await second).toEqual([]);
  });

  it('creates the key with the name, the TV, the explicit actions and the expiry', async () => {
    const list = ['volume_up', 'key:HOME'];
    const created = api.create('iPhone', 't1', list, 30);
    const request = http.expectOne('/api/v1/tv/siri/tokens');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'iPhone',
      tvId: 't1',
      actions: ['volume_up', 'key:HOME'],
      expiresInDays: 30,
    });
    list.push('power_off');
    expect(request.request.body.actions).toEqual(['volume_up', 'key:HOME']);
    request.flush({ id: 'k1', token: 'atalho_segredo' });
    expect((await created).token).toBe('atalho_segredo');
  });

  it('sends no expiry as null', async () => {
    const created = api.create('iPhone', 't1', ['mute'], null);
    const request = http.expectOne('/api/v1/tv/siri/tokens');
    expect(request.request.body.expiresInDays).toBeNull();
    request.flush({});
    await created;
  });

  it('revokes by id, encoding it', async () => {
    const done = api.revoke('a b');
    const request = http.expectOne('/api/v1/tv/siri/tokens/a%20b');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
  });

  it('asks for the apps of that TV, keeps only the installed ones and names them like the remote does', async () => {
    const apps = api.apps('t1');
    const request = http.expectOne((r) => r.url === '/api/v1/tv/shortcuts');
    expect(request.request.params.get('tvId')).toBe('t1');
    request.flush([
      {
        id: 'a1',
        position: 1,
        package: 'com.exemplo.video',
        tvLabel: 'Vídeo',
        customLabel: null,
        enabled: true,
        installed: true,
      },
      {
        id: 'a2',
        position: 2,
        package: 'com.exemplo.velho',
        tvLabel: 'Velho',
        customLabel: null,
        enabled: true,
        installed: false,
      },
      {
        id: 'a3',
        position: 3,
        package: 'com.exemplo.sem.nome',
        tvLabel: null,
        customLabel: null,
        enabled: true,
        installed: true,
      },
      {
        id: 'a4',
        position: 4,
        package: 'com.exemplo.renomeado',
        tvLabel: 'Original',
        customLabel: ' Meu app ',
        enabled: true,
        installed: true,
      },
    ]);
    expect(await apps).toEqual([
      { id: 'a1', name: 'Vídeo' },
      { id: 'a3', name: 'Atalho 3' },
      { id: 'a4', name: 'Meu app' },
    ]);
  });
});
