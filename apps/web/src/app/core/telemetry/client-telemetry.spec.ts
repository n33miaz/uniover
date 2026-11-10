import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { QUIET_REQUEST } from '../connectivity/quiet-request';
import { ResumeGrace } from '../connectivity/resume-grace';
import { SessionState } from '../session/session-state';
import {
  CLIENT_EVENTS_PATH,
  ClientTelemetry,
  TELEMETRY_CONFIG,
  type TelemetryConfig,
  moduleOfApiPath,
} from './client-telemetry';

const LEGACY_KEY = 'uniover.telemetry.queue';
const A = 'conta-a';
const B = 'conta-b';
const keyOf = (account: string) => `${LEGACY_KEY}.${account}`;

function signIn(account: string) {
  const session = TestBed.inject(SessionState);
  session.setToken('t', 600);
  session.setUser({
    id: account,
    email: `${account}@exemplo.com`,
    displayName: account,
    role: 'owner',
  });
}

interface Stored {
  account: string;
  event: Record<string, unknown>;
}
const stored = (account = A): Stored[] =>
  JSON.parse(window.localStorage.getItem(keyOf(account)) ?? '[]') as Stored[];

const baseConfig: TelemetryConfig = {
  queueMax: 20,
  batchMax: 20,
  flushDelayMs: 8_000,
  retryMs: 60_000,
  dedupeMs: 30_000,
  sessionMax: 100,
  sampling: { 'client-error': 1, 'http-failure': 1, 'command-failure': 1, 'command-slow': 1 },
  random: () => 0,
};

function setup(overrides: Partial<TelemetryConfig> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: TELEMETRY_CONFIG, useValue: { ...baseConfig, ...overrides } },
    ],
  });
  signIn(A);
  return {
    telemetry: TestBed.inject(ClientTelemetry),
    backend: TestBed.inject(HttpTestingController),
  };
}

describe('ClientTelemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const account of [A, B]) window.localStorage.removeItem(keyOf(account));
    window.localStorage.removeItem(LEGACY_KEY);
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const account of [A, B]) window.localStorage.removeItem(keyOf(account));
    window.localStorage.removeItem(LEGACY_KEY);
  });

  it('sends the queued events in one authenticated batch after the delay, marked as quiet', async () => {
    const { telemetry, backend } = setup();
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    telemetry.record({
      kind: 'command-failure',
      module: 'pc',
      code: 'timeout',
      transport: 'direct',
    });
    backend.expectNone(CLIENT_EVENTS_PATH);
    await vi.advanceTimersByTimeAsync(8_100);
    const request = backend.expectOne(CLIENT_EVENTS_PATH);
    expect(request.request.method).toBe('POST');
    expect(request.request.context.get(QUIET_REQUEST)).toBe(true);
    const events = (request.request.body as { events: Record<string, unknown>[] }).events;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'command-failure',
      module: 'tv',
      code: 'network',
      visibility: 'visible',
      grace: false,
    });
    expect(events[1]).toMatchObject({ module: 'pc', transport: 'direct' });
    expect(typeof events[0]['id']).toBe('string');
    expect(typeof events[0]['version']).toBe('string');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.pending).toBe(0);
    expect(stored()).toEqual([]);
  });

  it('collapses a repeated event inside the window and counts it again after', async () => {
    const { telemetry } = setup();
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    expect(telemetry.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    expect(telemetry.pending).toBe(2);
  });

  it('samples by kind', () => {
    const { telemetry } = setup({
      sampling: { 'client-error': 1, 'http-failure': 0.5, 'command-failure': 1, 'command-slow': 1 },
      random: () => 0.7,
    });
    telemetry.record({ kind: 'http-failure', module: 'tv', code: 'network', status: 0 });
    expect(telemetry.pending).toBe(0);
    telemetry.record({ kind: 'client-error', code: 'TypeError' });
    expect(telemetry.pending).toBe(1);
  });

  it('keeps the queue short: the oldest events leave first', () => {
    const { telemetry } = setup({ queueMax: 3, dedupeMs: 0 });
    for (let i = 0; i < 5; i++) {
      telemetry.record({ kind: 'command-failure', module: 'tv', code: `c${i}` });
    }
    expect(telemetry.pending).toBe(3);
    expect(stored().map((item) => item.event['code'])).toEqual(['c2', 'c3', 'c4']);
  });

  it('stops accepting after the session cap, so a failure loop does not fill queue or database', () => {
    const { telemetry } = setup({ sessionMax: 2, dedupeMs: 0 });
    for (let i = 0; i < 10; i++) {
      telemetry.record({ kind: 'command-failure', module: 'tv', code: `c${i}` });
    }
    expect(telemetry.pending).toBe(2);
  });

  it('does not send offline or inside the grace period; it tries again later', async () => {
    const { telemetry, backend } = setup();
    const connectivity = TestBed.inject(ConnectivityService);
    connectivity.online.set(false);
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    await vi.advanceTimersByTimeAsync(8_100);
    backend.expectNone(CLIENT_EVENTS_PATH);

    connectivity.online.set(true);
    TestBed.inject(ResumeGrace).begin();
    await vi.advanceTimersByTimeAsync(60_100);
    backend.expectOne(CLIENT_EVENTS_PATH).flush(null, { status: 204, statusText: 'ok' });
  });

  it('keeps the batch when the server cannot take it now, and drops it when the server refuses it for good', async () => {
    const { telemetry, backend } = setup();
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    await vi.advanceTimersByTimeAsync(8_100);
    backend.expectOne(CLIENT_EVENTS_PATH).flush('x', { status: 503, statusText: 'fora' });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.pending).toBe(1);

    await vi.advanceTimersByTimeAsync(60_100);
    backend.expectOne(CLIENT_EVENTS_PATH).flush('x', { status: 400, statusText: 'inválido' });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.pending).toBe(0);
  });

  it('keeps the batch on 429', async () => {
    const { telemetry, backend } = setup();
    telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
    await vi.advanceTimersByTimeAsync(8_100);
    backend.expectOne(CLIENT_EVENTS_PATH).flush('x', { status: 429, statusText: 'muitos' });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.pending).toBe(1);
  });

  it('restores the queue saved by a previous visit, ignoring junk', () => {
    const event = { id: 'a', at: '2026-11-10T10:00:00Z', kind: 'client-error' };
    window.localStorage.setItem(
      keyOf(A),
      JSON.stringify([
        { account: A, event },
        { account: B, event: { ...event, id: 'b' } },
        { nope: true },
        'lixo',
      ]),
    );
    const { telemetry } = setup();
    expect(telemetry.pending).toBe(1);
  });

  it('survives corrupted storage', () => {
    window.localStorage.setItem(keyOf(A), '{não é json');
    const { telemetry } = setup();
    expect(telemetry.pending).toBe(0);
  });

  describe('per account', () => {
    it('keeps each event with the account that made it, under that account key, and sends only the event', async () => {
      const { telemetry, backend } = setup();
      telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
      expect(stored(A)[0].account).toBe(A);
      await vi.advanceTimersByTimeAsync(8_100);
      const request = backend.expectOne(CLIENT_EVENTS_PATH);
      const sent = (request.request.body as { events: Record<string, unknown>[] }).events[0];
      // A marca da conta fica no aparelho: o servidor sabe quem enviou pela sessão, não por algo que o aparelho diga.
      expect(sent).not.toHaveProperty('account');
      request.flush(null, { status: 204, statusText: 'ok' });
    });

    it('signing out and in as another account never sends, nor keeps, what the first one left', async () => {
      const { telemetry, backend } = setup();
      TestBed.inject(ConnectivityService).online.set(false);
      telemetry.record({ kind: 'command-failure', module: 'tv', code: 'da-conta-a' });
      expect(stored(A)).toHaveLength(1);

      TestBed.inject(SessionState).clear('anonymous');
      signIn(B);
      TestBed.inject(ConnectivityService).online.set(true);
      await vi.advanceTimersByTimeAsync(70_000);

      backend.expectNone(CLIENT_EVENTS_PATH);
      expect(telemetry.pending).toBe(0);
      expect(window.localStorage.getItem(keyOf(A))).toBeNull();
    });

    it('the new account queue is its own: its events go out with its own session', async () => {
      const { telemetry, backend } = setup();
      telemetry.record({ kind: 'command-failure', module: 'tv', code: 'da-conta-a' });
      TestBed.inject(SessionState).clear('anonymous');
      signIn(B);
      telemetry.record({ kind: 'command-failure', module: 'tv', code: 'da-conta-b' });
      await vi.advanceTimersByTimeAsync(8_100);
      const request = backend.expectOne(CLIENT_EVENTS_PATH);
      const codes = (request.request.body as { events: { code: string }[] }).events.map(
        (e) => e.code,
      );
      expect(codes).toEqual(['da-conta-b']);
      request.flush(null, { status: 204, statusText: 'ok' });
    });

    it('without a known account nothing is stored (there is nobody to attribute it to)', () => {
      const { telemetry } = setup();
      TestBed.inject(SessionState).clear('anonymous');
      telemetry.record({ kind: 'client-error', code: 'Error' });
      expect(telemetry.pending).toBe(0);
    });

    it('does not send while the session in use is not the account that owns the queue', async () => {
      const { telemetry, backend } = setup();
      telemetry.record({ kind: 'command-failure', module: 'tv', code: 'network' });
      vi.spyOn(TestBed.inject(SessionState), 'isSessionOf').mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(8_100);
      backend.expectNone(CLIENT_EVENTS_PATH);
      expect(telemetry.pending).toBe(1);
    });

    it('drops the queue from before accounts existed (the key without an account)', () => {
      window.localStorage.setItem(LEGACY_KEY, '[{"id":"x"}]');
      setup();
      expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });

  it('never leaves a message, a stack or a query string in what is sent', async () => {
    const { telemetry, backend } = setup();
    const error = new TypeError('senha=1234 digitada pelo usuário');
    telemetry.recordError(error);
    const http = new HttpErrorResponse({
      status: 502,
      url: '/api/v1/pc/text/minha-senha?x=segredo',
      headers: new HttpHeaders({ 'X-Trace-Id': '4bf92f3577b34da6a3ce929d0e0e4736' }),
    });
    telemetry.recordHttp('POST', '/api/v1/pc/text/minha-senha?x=segredo', http);
    await vi.advanceTimersByTimeAsync(8_100);
    const request = backend.expectOne(CLIENT_EVENTS_PATH);
    const raw = JSON.stringify(request.request.body);
    expect(raw).not.toContain('senha=1234');
    expect(raw).not.toContain('segredo');
    expect(raw).not.toContain('stack');
    expect(raw).toContain('TypeError');
    expect(raw).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(raw).not.toContain('minha-senha');
    expect(raw).toContain('/api/v1/pc/text/:x');
    request.flush(null, { status: 204, statusText: 'ok' });
  });

  it('marks events born inside the grace period and the visibility state', () => {
    const { telemetry } = setup();
    TestBed.inject(ResumeGrace).begin();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    telemetry.record({ kind: 'client-error', code: 'Error' });
    expect(stored()[0].event).toMatchObject({ grace: true, visibility: 'hidden' });
  });

  it('only records the HTTP failures that matter', () => {
    const { telemetry } = setup({ dedupeMs: 0 });
    const fail = (status: number) => new HttpErrorResponse({ status });
    telemetry.recordHttp('GET', '/api/v1/tv/state', fail(404));
    telemetry.recordHttp('GET', '/api/v1/tv/state', fail(401));
    telemetry.recordHttp('POST', '/api/v1/tv/key', fail(401));
    expect(telemetry.pending).toBe(0);
    telemetry.recordHttp('GET', '/api/v1/tv/state', fail(0));
    telemetry.recordHttp('GET', '/api/v1/tv/state', fail(503));
    telemetry.recordHttp('POST', '/api/v1/tv/key', fail(409));
    expect(telemetry.pending).toBe(3);
  });

  it('record never throws, even with garbage', () => {
    const { telemetry } = setup();
    expect(() =>
      telemetry.record({ kind: 'client-error', code: 123 as unknown as string, status: NaN }),
    ).not.toThrow();
  });
});

describe('moduleOfApiPath', () => {
  it('maps the API path to the module', () => {
    expect(moduleOfApiPath('/api/v1/tv/key')).toBe('tv');
    expect(moduleOfApiPath('/api/v1/pc/click')).toBe('pc');
    expect(moduleOfApiPath('/api/v1/training/sessions')).toBe('training');
    expect(moduleOfApiPath('/api/v1/identity/me')).toBe('app');
  });
});
