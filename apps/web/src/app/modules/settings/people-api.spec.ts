import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PeopleApi } from './people-api';

describe('PeopleApi', () => {
  let api: PeopleApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PeopleApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('creates the invite with the name and the explicit list of permissions', async () => {
    const created = api.createInvite('Raphael', ['module:training']);
    const request = http.expectOne('/api/v1/identity/guest-invites');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      displayName: 'Raphael',
      permissions: ['module:training'],
    });
    request.flush({
      id: 'i1',
      displayName: 'Raphael',
      token: 'segredo',
      expiresAt: '2026-10-23T12:00:00Z',
      permissions: ['module:training'],
    });
    expect((await created).token).toBe('segredo');
  });

  it('sends the whole list when changing the permissions of a guest, and returns the guest as it ended up', async () => {
    const done = api.setPermissions('g 1', ['module:tv', 'tv:control']);
    const request = http.expectOne('/api/v1/identity/guests/g%201/permissions');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ permissions: ['module:tv', 'tv:control'] });
    request.flush({
      id: 'g 1',
      displayName: 'Bia',
      email: 'bia@exemplo.com',
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    expect((await done).permissions).toEqual(['module:tv', 'tv:control']);
  });

  it('does not share the list it was given with the request body', async () => {
    const list = ['module:training'];
    const done = api.setPermissions('g1', list);
    const request = http.expectOne('/api/v1/identity/guests/g1/permissions');
    list.push('module:tv');
    expect(request.request.body).toEqual({ permissions: ['module:training'] });
    request.flush({});
    await done;
  });
});
