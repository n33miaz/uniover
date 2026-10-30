import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { SessionState } from '../session/session-state';
import { StreamEvent, StreamService } from '../sse/stream.service';
import { HOME_STATUS_CONFIG, HomeStatusConfig, LiveHomeStatus } from './live-home-status';

const STATE = '/api/v1/tv/state';

describe('LiveHomeStatus', () => {
  const online = signal(true);
  const config: { -readonly [K in keyof HomeStatusConfig]: HomeStatusConfig[K] } = {
    pollMs: 30_000,
    watchdogTtlMs: 30 * 60_000,
  };
  let events: Subject<StreamEvent>;
  let open: ReturnType<typeof vi.fn>;
  let http: HttpTestingController;
  let session: SessionState;
  let live: LiveHomeStatus;
  let stops: (() => void)[];

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
  };
  const signIn = (
    role: string | undefined = 'owner',
    { id = '1', permissions }: { id?: string; permissions?: string[] } = {},
  ) => {
    session.setToken('token-de-teste', 600);
    session.setUser({ id, email: 'a@b.c', displayName: 'Neemias', role, permissions });
  };
  const ALERTS = '/api/v1/devices/agent-alerts';
  /** A tela aparece: começa o acompanhamento e deixa os efeitos rodarem. */
  const watch = () => {
    const stop = live.watch();
    stops.push(stop);
    TestBed.tick();
    return stop;
  };
  const answer = (body: unknown = { agentOnline: true }) =>
    http.expectOne(STATE).flush(body as Record<string, unknown>);
  const emit = (type: string, data: unknown) =>
    events.next({
      type,
      data: typeof data === 'string' ? data : JSON.stringify(data),
      lastEventId: '',
    });
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };
  const watchdog = (kind: string, severity: string) =>
    emit('tv.watchdog', { kind, severity, detail: '', attempts: 1, at: '2026-10-20T10:00:00Z' });

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0));
    localStorage.clear();
    online.set(true);
    config.pollMs = 30_000;
    config.watchdogTtlMs = 30 * 60_000;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    events = new Subject<StreamEvent>();
    open = vi.fn(() => events.asObservable());
    stops = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: HOME_STATUS_CONFIG, useValue: config },
        { provide: StreamService, useValue: { open } },
        { provide: ConnectivityService, useValue: { online } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(SessionState);
    live = TestBed.inject(LiveHomeStatus);
  });

  afterEach(() => {
    for (const stop of stops) stop();
    TestBed.tick();
    localStorage.clear();
    vi.useRealTimers();
  });

  describe('without permission to ask', () => {
    it('makes no call and opens no stream without a session', () => {
      watch();
      advance(120_000);
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
      expect(live.status().agent).toBe('unknown');
    });

    it('waits while the session is still being confirmed', () => {
      signIn();
      session.clear('unknown');
      session.setPending();
      watch();
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
    });

    it('never calls for a guest without the TV', () => {
      signIn('guest', { permissions: ['module:training'] });
      watch();
      advance(120_000);
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
    });

    it('never calls for a guest whose permission list is not known', () => {
      signIn('guest');
      watch();
      advance(120_000);
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
    });

    it('never calls while the role is unknown', () => {
      session.setToken('token-de-teste', 600);
      watch();
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
    });

    it('starts as soon as the session turns into the owner one', () => {
      watch();
      http.expectNone(STATE);
      signIn();
      TestBed.tick();
      answer({ agentOnline: false });
      expect(live.status().agent).toBe('offline');
    });

    it('does not call before anyone is watching', () => {
      signIn();
      TestBed.tick();
      http.expectNone(STATE);
      expect(open).not.toHaveBeenCalled();
    });
  });

  describe('agent', () => {
    beforeEach(() => signIn());

    it('reads the state on entering and says the agent is on', () => {
      watch();
      expect(live.status().agent).toBe('unknown');
      answer({ agentOnline: true, connection: 'hot', power: 'on', volume: 22 });
      expect(live.status()).toEqual({
        userName: 'Neemias',
        agent: 'online',
        watcher: 'unknown',
        serviceDown: false,
        agentAlert: null,
      });
    });

    it('reutiliza o último estado salvo antes da primeira leitura em segundo plano', () => {
      localStorage.setItem('uniover.home.agent.v2.1', 'online');
      const cached = TestBed.runInInjectionContext(() => new LiveHomeStatus());
      expect(cached.status().agent).toBe('online');
      expect(cached.loading()).toBe(false);
    });

    it('só mostra espera depois do atraso, e a resposta troca pelo estado sem apagar a tela', () => {
      watch();
      expect(live.loading()).toBe(false);
      advance(399);
      expect(live.loading()).toBe(false);
      advance(1);
      expect(live.loading()).toBe(true);
      answer({ agentOnline: true });
      expect(live.loading()).toBe(false);
      expect(live.status().agent).toBe('online');
    });

    it('para a espera sozinha se a leitura nunca volta (o brilho não fica em laço)', () => {
      watch();
      advance(400);
      expect(live.loading()).toBe(true);
      advance(7_599);
      expect(live.loading()).toBe(true);
      advance(1);
      expect(live.loading()).toBe(false);
    });

    it('guarda o último estado por conta, sob a chave dela', () => {
      watch();
      answer({ agentOnline: true });
      expect(localStorage.getItem('uniover.home.agent.v2.1')).toBe('online');
      expect(localStorage.getItem('uniover.home.agent.v1')).toBeNull();
    });

    it('says the agent is off', () => {
      watch();
      answer({ agentOnline: false, connection: 'disconnected', power: 'unknown' });
      expect(live.status().agent).toBe('offline');
    });

    it('says "no data" when the body does not tell', () => {
      watch();
      answer({ power: 'on' });
      expect(live.status().agent).toBe('unknown');
    });

    it('opens the stream on the plain events path, for the state and the watchdog only', () => {
      watch();
      answer();
      expect(open).toHaveBeenCalledTimes(1);
      const [path, types] = open.mock.calls[0];
      expect(path).toBe('/api/v1/tv/events');
      expect(path).not.toMatch(/token|\?/);
      expect(types).toEqual(['tv.state', 'tv.watchdog']);
    });

    it('follows the agent in real time from the stream', () => {
      watch();
      answer({ agentOnline: true });
      emit('tv.state', { agentOnline: false, connection: 'disconnected' });
      expect(live.status().agent).toBe('offline');
      emit('tv.state', { agentOnline: true, connection: 'hot' });
      expect(live.status().agent).toBe('online');
    });

    it('ignores stream events it cannot read', () => {
      watch();
      answer({ agentOnline: true });
      emit('tv.state', 'não é json');
      emit('tv.state', { power: 'on' });
      emit('tv.watchdog', { kind: 'repair_failed' });
      emit('tv.watchdog', 'não é json');
      expect(live.status().agent).toBe('online');
    });

    it('takes the name from the session', () => {
      expect(live.status().userName).toBe('Neemias');
      session.clear('anonymous');
      expect(live.status().userName).toBeNull();
    });
  });

  describe('watcher', () => {
    beforeEach(() => {
      signIn();
      watch();
      answer({ agentOnline: true });
    });

    it('stays "no data" without evidence', () => {
      expect(live.status().watcher).toBe('unknown');
    });

    it('turns into an alert on an error or a failed repair', () => {
      watchdog('repair_failed', 'error');
      expect(live.status().watcher).toBe('alert');
    });

    it('treats the error severity as an alert whatever the kind', () => {
      watchdog('adb_unreachable', 'error');
      expect(live.status().watcher).toBe('alert');
    });

    it('treats a failed repair as an alert even with a lower severity', () => {
      watchdog('repair_failed', 'warn');
      expect(live.status().watcher).toBe('alert');
    });

    it('is "in order" after a repair or a recovery', () => {
      watchdog('repaired', 'info');
      expect(live.status().watcher).toBe('ok');
      watchdog('repair_failed', 'error');
      expect(live.status().watcher).toBe('alert');
      watchdog('recovered', 'info');
      expect(live.status().watcher).toBe('ok');
    });

    it('does not move on steps that have not ended in either way', () => {
      watchdog('port_closed', 'warn');
      watchdog('repair_started', 'info');
      watchdog('adb_unreachable', 'warn');
      expect(live.status().watcher).toBe('unknown');
      watchdog('repair_failed', 'error');
      watchdog('port_closed', 'warn');
      expect(live.status().watcher).toBe('alert');
    });

    it('says nothing while the agent is off, since the watcher lives inside it', () => {
      watchdog('repair_failed', 'error');
      emit('tv.state', { agentOnline: false });
      expect(live.status().watcher).toBe('unknown');
      emit('tv.state', { agentOnline: true });
      expect(live.status().watcher).toBe('alert');
    });

    it('lets old evidence expire, because nobody was listening in the meantime', () => {
      config.watchdogTtlMs = 60_000;
      watchdog('repair_failed', 'error');
      advance(30_000);
      http.match(STATE).forEach((request) => request.flush({ agentOnline: true }));
      expect(live.status().watcher).toBe('alert');
      advance(70_000);
      http.match(STATE).forEach((request) => request.flush({ agentOnline: true }));
      expect(live.status().watcher).toBe('unknown');
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      signIn();
      watch();
      answer();
    });

    it('asks again every 30 seconds while the tab is visible', () => {
      http.expectNone(STATE);
      advance(29_000);
      http.expectNone(STATE);
      advance(1_000);
      answer({ agentOnline: false });
      expect(live.status().agent).toBe('offline');
      advance(30_000);
      answer({ agentOnline: true });
      expect(live.status().agent).toBe('online');
    });

    it('does not pile a request on top of one that has not answered', () => {
      advance(30_000);
      const slow = http.expectOne(STATE);
      advance(90_000);
      http.expectNone(STATE);
      slow.flush({ agentOnline: true });
      advance(30_000);
      http.expectOne(STATE).flush({ agentOnline: true });
    });

    it('stops while the tab is hidden and asks again on coming back', () => {
      setVisibility('hidden');
      expect(events.observed).toBe(false);
      advance(120_000);
      http.expectNone(STATE);
      setVisibility('visible');
      answer({ agentOnline: false });
      expect(events.observed).toBe(true);
      expect(live.status().agent).toBe('offline');
    });
  });

  describe('without network', () => {
    beforeEach(() => {
      signIn();
      watch();
      answer({ agentOnline: true });
    });

    it('makes no call, keeps the last value and shows no error', () => {
      online.set(false);
      TestBed.tick();
      advance(120_000);
      http.expectNone(STATE);
      expect(events.observed).toBe(false);
      expect(live.status()).toMatchObject({ agent: 'online', serviceDown: false });
    });

    it('asks again as soon as the network is back', () => {
      online.set(false);
      TestBed.tick();
      online.set(true);
      TestBed.tick();
      answer({ agentOnline: false });
      expect(events.observed).toBe(true);
      expect(live.status().agent).toBe('offline');
    });

    it('does not blame the service for a call that failed because the device lost the network', () => {
      advance(30_000);
      const request = http.expectOne(STATE);
      online.set(false);
      request.error(new ProgressEvent('error'), { status: 0 });
      expect(live.status()).toMatchObject({ agent: 'online', serviceDown: false });
    });
  });

  describe('service down', () => {
    beforeEach(() => {
      signIn();
      watch();
      answer({ agentOnline: true });
    });

    it('is reported only when the API did not answer, and clears when it does', () => {
      advance(30_000);
      http.expectOne(STATE).error(new ProgressEvent('error'), { status: 0 });
      expect(live.status()).toMatchObject({ agent: 'unknown', serviceDown: true });
      advance(30_000);
      answer({ agentOnline: true });
      expect(live.status()).toMatchObject({ agent: 'online', serviceDown: false });
    });

    it.each([502, 503, 504])('is reported for the %i of the proxy', (status) => {
      advance(30_000);
      http.expectOne(STATE).flush('', { status, statusText: 'Gateway' });
      expect(live.status().serviceDown).toBe(true);
    });

    it.each([429, 500])('is not reported for a %i, and the last state stays', (status) => {
      advance(30_000);
      http.expectOne(STATE).flush('', { status, statusText: 'Resposta' });
      expect(live.status()).toMatchObject({ agent: 'online', serviceDown: false });
    });

    it.each([401, 403, 404])(
      'is not reported for a %i, but the agent state is dropped and its remembered value erased',
      (status) => {
        expect(localStorage.getItem('uniover.home.agent.v2.1')).toBe('online');
        advance(30_000);
        http.expectOne(STATE).flush('', { status, statusText: 'Resposta' });
        expect(live.status()).toMatchObject({ agent: 'unknown', serviceDown: false });
        expect(localStorage.getItem('uniover.home.agent.v2.1')).toBeNull();
      },
    );

    it('clears on any stream event too', () => {
      advance(30_000);
      http.expectOne(STATE).error(new ProgressEvent('error'), { status: 0 });
      expect(live.status().serviceDown).toBe(true);
      emit('tv.state', { agentOnline: true });
      expect(live.status()).toMatchObject({ agent: 'online', serviceDown: false });
    });
  });

  describe('leaving', () => {
    beforeEach(() => signIn());

    it('cancels the request in flight, the timer and the stream when the screen goes away', () => {
      const stop = watch();
      const slow = http.expectOne(STATE);
      expect(events.observed).toBe(true);
      stop();
      TestBed.tick();
      expect(slow.cancelled).toBe(true);
      expect(events.observed).toBe(false);
      advance(120_000);
      http.expectNone(STATE);
    });

    it('keeps going while someone is still watching', () => {
      const first = watch();
      answer();
      const second = watch();
      first();
      first();
      TestBed.tick();
      expect(events.observed).toBe(true);
      advance(30_000);
      http.expectOne(STATE).flush({ agentOnline: true });
      second();
      TestBed.tick();
      expect(events.observed).toBe(false);
    });

    it('asks at once when the screen comes back', () => {
      const stop = watch();
      answer({ agentOnline: true });
      stop();
      TestBed.tick();
      watch();
      answer({ agentOnline: false });
      expect(open).toHaveBeenCalledTimes(2);
      expect(live.status().agent).toBe('offline');
    });

    it('cancels everything and forgets what it knew when the session ends', () => {
      watch();
      answer({ agentOnline: true });
      watchdog('repair_failed', 'error');
      advance(30_000);
      const pending = http.expectOne(STATE);
      session.clear('anonymous');
      TestBed.tick();
      expect(pending.cancelled).toBe(true);
      expect(events.observed).toBe(false);
      expect(live.status()).toEqual({
        userName: null,
        agent: 'unknown',
        watcher: 'unknown',
        serviceDown: false,
        agentAlert: null,
      });
      advance(120_000);
      http.expectNone(STATE);
    });
  });
  describe('a guest with the TV', () => {
    const TV = ['module:tv', 'tv:control'];

    it('reads the state and opens the stream of their own TV', () => {
      signIn('guest', { id: 'g1', permissions: TV });
      watch();
      answer({ agentOnline: true });
      expect(live.status().agent).toBe('online');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe('/api/v1/tv/events');
    });

    it('never asks for the computer-down notices, which belong to the owner', () => {
      signIn('guest', { id: 'g1', permissions: TV });
      watch();
      answer();
      advance(30_000);
      answer();
      http.expectNone(ALERTS);
      expect(live.status().agentAlert).toBeNull();
    });

    it('does not borrow what the owner left remembered in the same browser', () => {
      localStorage.setItem('uniover.home.agent.v2.1', 'online');
      signIn('guest', { id: 'g1', permissions: TV });
      watch();
      expect(live.status().agent).toBe('unknown');
      answer({ agentOnline: false });
      expect(live.status().agent).toBe('offline');
      expect(localStorage.getItem('uniover.home.agent.v2.g1')).toBe('offline');
      expect(localStorage.getItem('uniover.home.agent.v2.1')).toBe('online');
    });

    it('stops reading as soon as the TV permission is taken away', () => {
      signIn('guest', { id: 'g1', permissions: TV });
      watch();
      const pending = http.expectOne(STATE);
      signIn('guest', { id: 'g1', permissions: ['module:training'] });
      TestBed.tick();
      expect(pending.cancelled).toBe(true);
      expect(events.observed).toBe(false);
    });

    it('drops what the previous account knew when another one takes the browser', () => {
      signIn('owner');
      watch();
      answer({ agentOnline: true });
      http.expectOne(ALERTS).flush([
        {
          id: 'o1',
          agentId: 'a1',
          agentName: 'PC da sala',
          detectedAt: '2026-10-20T09:00:00Z',
          lastSeenAt: null,
          recoveredAt: null,
        },
      ]);
      expect(live.status().agentAlert).not.toBeNull();

      // Sem passar por "sair": o mesmo navegador passa direto para a conta do convidado.
      signIn('guest', { id: 'g1', permissions: TV });
      TestBed.tick();
      expect(live.status().agent).toBe('unknown');
      expect(live.status().agentAlert).toBeNull();
      answer({ agentOnline: false });
      expect(live.status().agent).toBe('offline');
      http.expectNone(ALERTS);
    });
  });

  describe('agent alert', () => {
    beforeEach(() => signIn());

    const alert = (recoveredAt: string | null, name = 'PC da sala') => ({
      id: 'o1',
      agentId: 'a1',
      agentName: name,
      detectedAt: '2026-10-20T09:00:00Z',
      lastSeenAt: null,
      recoveredAt,
    });

    it('shows the computer that is down, from the same poll as the state', () => {
      watch();
      answer({ agentOnline: false });
      http.expectOne(ALERTS).flush([alert(null)]);
      expect(live.status().agentAlert).toEqual({ name: 'PC da sala', recovered: false });
    });

    it('says it is back when the only notice is a recovered one', () => {
      watch();
      answer();
      http.expectOne(ALERTS).flush([alert('2026-10-20T09:30:00Z')]);
      expect(live.status().agentAlert).toEqual({ name: 'PC da sala', recovered: true });
    });

    it('prefers an open outage over a recovered one', () => {
      watch();
      answer();
      http
        .expectOne(ALERTS)
        .flush([alert('2026-10-20T09:30:00Z', 'PC antigo'), alert(null, 'PC da sala')]);
      expect(live.status().agentAlert).toEqual({ name: 'PC da sala', recovered: false });
    });

    it('clears the notice when the list comes back empty', () => {
      watch();
      answer();
      http.expectOne(ALERTS).flush([alert(null)]);
      advance(30_000);
      answer();
      http.expectOne(ALERTS).flush([]);
      expect(live.status().agentAlert).toBeNull();
    });

    it('ignores a failed read: no notice and no "service down"', () => {
      watch();
      answer();
      http.expectOne(ALERTS).flush(null, { status: 500, statusText: 'x' });
      expect(live.status().agentAlert).toBeNull();
      expect(live.status().serviceDown).toBe(false);
    });

    it('never asks a guest', () => {
      signIn('guest');
      watch();
      http.expectNone(ALERTS);
    });
  });
});
