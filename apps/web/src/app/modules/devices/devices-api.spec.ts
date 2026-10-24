import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DevicesApi } from './devices-api';

describe('DevicesApi', () => {
  let api: DevicesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(DevicesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the agents', async () => {
    const list = api.list();
    const request = http.expectOne('/api/v1/devices/agents');
    expect(request.request.method).toBe('GET');
    request.flush([
      {
        id: 'a1',
        slug: 'agent:pc',
        name: 'PC',
        platform: 'windows',
        createdAt: 'x',
        revoked: false,
      },
    ]);
    expect((await list).map((a) => a.name)).toEqual(['PC']);
  });

  it('approves with a JSON body carrying the code, the name and who the TV is for', async () => {
    const done = api.approve('BCDF2345', 'PC de casa', 'TV de Ana', ['g1']);
    const request = http.expectOne('/api/v1/devices/pairing/approve');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      userCode: 'BCDF2345',
      name: 'PC de casa',
      tvName: 'TV de Ana',
      tvMemberIds: ['g1'],
    });
    request.flush({ id: 'a1', slug: 'agent:pc', name: 'PC de casa', platform: 'windows' });
    await done;
  });

  it('denies with a JSON body', async () => {
    const done = api.deny('BCDF2345');
    const request = http.expectOne('/api/v1/devices/pairing/deny');
    expect(request.request.body).toEqual({ userCode: 'BCDF2345' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
  });

  it('revokes with a JSON body, never an empty one', async () => {
    const done = api.revoke('a1');
    const request = http.expectOne('/api/v1/devices/agents/a1/revoke');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: null });
    request.flush({ id: 'a1', revoked: true });
    await done;
  });
});
