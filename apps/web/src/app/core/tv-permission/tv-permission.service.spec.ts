import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TV_PERMISSION_DISMISSED_KEY, TvPermissionService } from './tv-permission.service';

const PROBLEM = 'https://uniover.app/problems/';

describe('TvPermissionService', () => {
  let service: TvPermissionService;
  let http: HttpTestingController;

  function create(): void {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(TvPermissionService);
    http = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    sessionStorage.removeItem(TV_PERMISSION_DISMISSED_KEY);
    vi.useRealTimers();
    http.verify();
  });

  it('reads the TVs that still need the accept', async () => {
    create();
    const read = service.refresh();
    const request = http.expectOne('/api/v1/tv/permission');
    expect(request.request.method).toBe('GET');
    request.flush({
      items: [
        { tvId: 'tv-2', name: 'Raphael' },
        { tvId: '', name: 'sem id' },
        { name: 'sem tvId' },
      ],
    });
    await read;
    expect(service.pending()).toEqual([{ tvId: 'tv-2', name: 'Raphael' }]);
    expect(service.current()).toEqual({ tvId: 'tv-2', name: 'Raphael' });
  });

  it('never traps anyone: an error leaves the list empty', async () => {
    create();
    const read = service.refresh();
    http.expectOne('/api/v1/tv/permission').flush({}, { status: 404, statusText: 'Not Found' });
    await read;
    expect(service.pending()).toEqual([]);
    expect(service.current()).toBeNull();
  });

  it('a malformed answer is an empty list', async () => {
    create();
    const read = service.refresh();
    http.expectOne('/api/v1/tv/permission').flush('texto');
    await read;
    expect(service.pending()).toEqual([]);
  });

  it('Depois hides the TV for this visit only, and remembers it in the tab', async () => {
    create();
    const read = service.refresh();
    http.expectOne('/api/v1/tv/permission').flush({ items: [{ tvId: 'tv-2', name: 'Raphael' }] });
    await read;
    service.dismiss('tv-2');
    expect(service.current()).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(TV_PERMISSION_DISMISSED_KEY)!)).toEqual(['tv-2']);
  });

  it('the sheet comes back in the next visit (new tab storage)', () => {
    sessionStorage.setItem(TV_PERMISSION_DISMISSED_KEY, JSON.stringify(['tv-2']));
    create();
    // Mesma aba: ainda adiada.
    expect(service.current()).toBeNull();
    service.pending.set([{ tvId: 'tv-2', name: 'Raphael' }]);
    expect(service.current()).toBeNull();
    sessionStorage.removeItem(TV_PERMISSION_DISMISSED_KEY);
  });

  it('survives a broken tab storage', () => {
    sessionStorage.setItem(TV_PERMISSION_DISMISSED_KEY, '{nao e json');
    create();
    service.pending.set([{ tvId: 'tv-2', name: 'Raphael' }]);
    expect(service.current()).toEqual({ tvId: 'tv-2', name: 'Raphael' });
  });

  it('asks the agent through the TV chosen by id', async () => {
    create();
    const ask = service.ask('tv-2');
    const request = http.expectOne('/api/v1/tv/permission/request?tvId=tv-2');
    expect(request.request.method).toBe('POST');
    request.flush({ ok: true, latencyMs: 40 });
    expect(await ask).toBe('asked');
  });

  it.each([
    ['agent-offline', 503, {}, 'unreachable'],
    ['agent-timeout', 504, {}, 'unreachable'],
    ['command-failed', 502, { agentError: 'tv_unreachable' }, 'unreachable'],
    ['command-failed', 502, { agentError: 'permission_in_progress' }, 'busy'],
    ['permission-unsupported', 409, {}, 'unsupported'],
    ['command-failed', 502, { agentError: 'outro' }, 'failed'],
    ['', 500, {}, 'failed'],
  ])('maps %s (%d) to %s', async (kind, status, extra, expected) => {
    create();
    const ask = service.ask('tv-2');
    http
      .expectOne('/api/v1/tv/permission/request?tvId=tv-2')
      .flush(
        { type: kind ? PROBLEM + kind : undefined, title: 'x', status, ...extra },
        { status, statusText: 'x' },
      );
    expect(await ask).toBe(expected);
  });

  it('a network failure while asking is a failure, not a thrown error', async () => {
    create();
    const ask = service.ask('tv-2');
    http.expectOne('/api/v1/tv/permission/request?tvId=tv-2').error(new ProgressEvent('error'));
    expect(await ask).toBe('failed');
  });

  it('waits for the accept by polling until the TV no longer needs it', async () => {
    create();
    let calls = 0;
    const granted = await service.waitForGrant(async () => ++calls < 3, {
      intervalMs: 1,
      timeoutMs: 1000,
    });
    expect(granted).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up when nobody accepts in time', async () => {
    create();
    const granted = await service.waitForGrant(async () => true, { intervalMs: 1, timeoutMs: 15 });
    expect(granted).toBe(false);
  });

  it('stillPending reads the list and tells whether the TV is on it, without removing the open sheet', async () => {
    create();
    service.pending.set([{ tvId: 'tv-2', name: 'Raphael' }]);
    const check = service.stillPending('tv-2');
    http.expectOne('/api/v1/tv/permission').flush({ items: [] });
    expect(await check).toBe(false);
    // A folha aberta é a `current`: ela só sai quando quem a fecha lê a lista de novo.
    expect(service.current()).toEqual({ tvId: 'tv-2', name: 'Raphael' });

    const failing = service.stillPending('tv-2');
    http.expectOne('/api/v1/tv/permission').error(new ProgressEvent('error'));
    // Sem leitura, continua esperando em vez de dar por concedido.
    expect(await failing).toBe(true);
  });
});
