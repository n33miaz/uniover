import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AUDIT_PAGE_SIZE, AuditApi, filenameFrom, paramsOf } from './audit-api';
import { AuditQuery, EMPTY_QUERY } from './audit-model';

const QUERY: AuditQuery = {
  person: 'conta-1',
  modules: ['tv', 'devices'],
  actions: ['tv.key'],
  outcome: 'failure',
  from: '2026-10-14T15:00:00.000Z',
};

describe('paramsOf', () => {
  it('sends nothing for an empty query', () => {
    expect(paramsOf(EMPTY_QUERY, null, null).keys()).toEqual([]);
  });

  it('repeats module and action, and sends the rest once', () => {
    const params = paramsOf(QUERY, 'proximo', 25);
    expect(params.getAll('module')).toEqual(['tv', 'devices']);
    expect(params.getAll('action')).toEqual(['tv.key']);
    expect(params.get('person')).toBe('conta-1');
    expect(params.get('outcome')).toBe('failure');
    expect(params.get('from')).toBe('2026-10-14T15:00:00.000Z');
    expect(params.get('cursor')).toBe('proximo');
    expect(params.get('limit')).toBe('25');
  });
});

describe('filenameFrom', () => {
  it('reads the name the server suggests, with or without quotes', () => {
    expect(filenameFrom('attachment; filename=auditoria-20261021-1500.csv')).toBe(
      'auditoria-20261021-1500.csv',
    );
    expect(
      filenameFrom(
        'attachment; filename="auditoria-20261021-1500.csv"; filename*=UTF-8\'\'auditoria-20261021-1500.csv',
      ),
    ).toBe('auditoria-20261021-1500.csv');
  });

  it('gives null when there is no name', () => {
    expect(filenameFrom(null)).toBeNull();
    expect(filenameFrom('attachment')).toBeNull();
  });
});

describe('AuditApi', () => {
  let api: AuditApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AuditApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the sources, which carry the retention of each trail', async () => {
    const done = api.sources();
    const request = http.expectOne('/api/v1/identity/audit/sources');
    expect(request.request.method).toBe('GET');
    request.flush({
      outcomes: ['success', 'failure', 'denied'],
      sources: [{ module: 'tv', retentionDays: 30, actions: ['tv.key'] }],
    });
    expect((await done).sources[0].retentionDays).toBe(30);
  });

  it('asks for one page at a time: a small limit, the filters, and the cursor of the page before', async () => {
    const done = api.list(QUERY, 'cursor-1');
    const request = http.expectOne((req) => req.url === '/api/v1/identity/audit');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe(String(AUDIT_PAGE_SIZE));
    expect(request.request.params.get('cursor')).toBe('cursor-1');
    expect(request.request.params.getAll('module')).toEqual(['tv', 'devices']);
    expect(request.request.params.get('person')).toBe('conta-1');
    request.flush({ items: [], nextCursor: null });
    expect(await done).toEqual({ items: [], nextCursor: null });
  });

  it('asks for the first page without a cursor', async () => {
    const done = api.list(EMPTY_QUERY);
    const request = http.expectOne((req) => req.url === '/api/v1/identity/audit');
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [], nextCursor: null });
    await done;
  });

  it('exports with the same filters and no page, and reads the truncation notice and the file name', async () => {
    const done = api.export(QUERY);
    const request = http.expectOne((req) => req.url === '/api/v1/identity/audit/export');
    expect(request.request.responseType).toBe('blob');
    expect(request.request.params.getAll('module')).toEqual(['tv', 'devices']);
    expect(request.request.params.has('limit')).toBe(false);
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush(new Blob(['a;b']), {
      headers: {
        'X-Audit-Truncated': 'true',
        'Content-Disposition': 'attachment; filename=auditoria-20261021-1500.csv',
      },
    });
    const file = await done;
    expect(file.truncated).toBe(true);
    expect(file.filename).toBe('auditoria-20261021-1500.csv');
    expect(await file.blob.text()).toBe('a;b');
  });

  it('says the file is complete when the server sends no truncation notice', async () => {
    const done = api.export(EMPTY_QUERY);
    http.expectOne((req) => req.url === '/api/v1/identity/audit/export').flush(new Blob(['x']));
    const file = await done;
    expect(file.truncated).toBe(false);
    expect(file.filename).toBeNull();
  });

  it('lists the guests for the person filter keeping only id and name, never the e-mail', async () => {
    const done = api.guests();
    http.expectOne('/api/v1/identity/guests').flush([
      {
        id: 'g1',
        displayName: 'Bruno',
        email: 'bruno@exemplo.com',
        createdAt: '2026-10-10T10:00:00Z',
        disabledAt: null,
        permissions: ['module:tv'],
      },
    ]);
    const people = await done;
    expect(people).toEqual([{ id: 'g1', name: 'Bruno' }]);
    expect(JSON.stringify(people)).not.toContain('exemplo.com');
  });
});
