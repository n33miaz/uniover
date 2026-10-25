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

  it('approves his own PC with only the code and the TV name (no people, no default)', async () => {
    const done = api.approveOwn('BCDF2345', 'TV de Raphael');
    const request = http.expectOne('/api/v1/devices/pairing/approve-own');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      userCode: 'BCDF2345',
      name: null,
      tvName: 'TV de Raphael',
    });
    request.flush({ id: 'a1', slug: 'agent:pc', name: 'PC', platform: 'windows' });
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

  it('asks for the log with a JSON body and reads the numbers the API may send as text', async () => {
    const done = api.logs('a 1');
    const request = http.expectOne('/api/v1/devices/agents/a%201/logs');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ lines: 300 });
    request.flush({ text: 'a\nb', lines: '2', truncated: true, at: '2026-10-24T14:00:00Z' });
    expect(await done).toEqual({
      text: 'a\nb',
      lines: 2,
      truncated: true,
      at: '2026-10-24T14:00:00Z',
    });
  });

  it('asks for as many lines as the caller wants', async () => {
    const done = api.logs('a1', 50);
    const request = http.expectOne('/api/v1/devices/agents/a1/logs');
    expect(request.request.body).toEqual({ lines: 50 });
    request.flush({ text: '', lines: 0, truncated: false, at: 'x' });
    await done;
  });

  it.each(['update', 'restart'] as const)('asks to %s with a JSON body', async (action) => {
    const done = api.maintain('a1', action);
    const request = http.expectOne('/api/v1/devices/agents/a1/maintenance');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ action });
    request.flush({ action, accepted: true });
    await done;
  });
});
