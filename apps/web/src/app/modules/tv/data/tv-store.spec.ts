import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ConnectivityService, ServerState } from '../../../core/connectivity/connectivity.service';
import { StreamEvent, StreamService } from '../../../core/sse/stream.service';
import { TvApi } from './tv-api';
import { ICONS_CACHE_MAX_CHARS, TvStore, isValidTvText } from './tv-store';
import { TvShortcut } from './tv-types';

const PROBLEM = 'https://uniover.app/problems/';

const problem = (status: number, kind = '', headers: Record<string, string> = {}) =>
  new HttpErrorResponse({
    status,
    headers: new HttpHeaders(headers),
    error: { type: kind ? PROBLEM + kind : undefined, status },
  });

const hot = {
  power: 'on',
  volume: 22,
  app: null,
  connection: 'hot',
  agentOnline: true,
  updatedAt: '2026-10-19T14:02:00Z',
};

const shortcut = (position: number, overrides: Partial<TvShortcut> = {}): TvShortcut => ({
  id: `s${position}`,
  position,
  package: `pacote.${position}`,
  tvLabel: null,
  customLabel: null,
  enabled: true,
  installed: true,
  iconDataUri: null,
  ...overrides,
});

describe('TvStore', () => {
  const online = signal(true);
  const serverState = signal<ServerState>('ok');
  let events: Subject<StreamEvent>;
  let open: ReturnType<typeof vi.fn>;
  const api = {
    state: vi.fn(),
    shortcuts: vi.fn(),
    wake: vi.fn(),
    sendKey: vi.fn(),
    sendText: vi.fn(),
    powerOff: vi.fn(),
    launch: vi.fn(),
    refreshShortcuts: vi.fn(),
    updateShortcut: vi.fn(),
  };
  let store: TvStore;

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const emit = (type: string, data: unknown = '') =>
    events.next({
      type,
      data: typeof data === 'string' ? data : JSON.stringify(data),
      lastEventId: '',
    });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const started = async () => {
    store.start();
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date(2026, 9, 19, 14, 30));
    localStorage.clear();
    online.set(true);
    serverState.set('ok');
    setVisibility('visible');
    events = new Subject<StreamEvent>();
    open = vi.fn(() => events.asObservable());
    for (const fn of Object.values(api)) fn.mockReset();
    api.state.mockResolvedValue({
      power: 'on',
      volume: 22,
      app: null,
      connection: 'hot',
      agentOnline: true,
      updatedAt: '2026-10-19T14:02:00Z',
    });
    api.shortcuts.mockResolvedValue([shortcut(1), shortcut(2)]);
    api.wake.mockResolvedValue(undefined);
    api.sendKey.mockResolvedValue(undefined);
    api.sendText.mockResolvedValue(undefined);
    api.powerOff.mockResolvedValue(undefined);
    api.launch.mockResolvedValue(undefined);
    api.refreshShortcuts.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: TvApi, useValue: api },
        { provide: StreamService, useValue: { open } },
        { provide: ConnectivityService, useValue: { online, serverState } },
      ],
    });
    store = TestBed.inject(TvStore);
  });

  afterEach(() => {
    store.stop();
    vi.useRealTimers();
  });

  describe('opening', () => {
    it('opens the stream on the plain events path and loads state, shortcuts and wakes', async () => {
      await started();
      expect(open).toHaveBeenCalledTimes(1);
      const [path, types] = open.mock.calls[0];
      expect(path).toBe('/api/v1/tv/events');
      expect(path).not.toMatch(/token|\?/);
      expect(types).toEqual(expect.arrayContaining(['tv.state', 'tv.shortcuts', 'tv.watchdog']));
      expect(api.state).toHaveBeenCalledTimes(1);
      expect(api.shortcuts).toHaveBeenCalledTimes(1);
      expect(api.wake).toHaveBeenCalledTimes(1);
      expect(store.state()?.volume).toBe(22);
      expect(store.shortcuts()?.map((item) => item.position)).toEqual([1, 2]);
      expect(store.status()).toBe('hot');
    });

    it('starts only once', async () => {
      await started();
      store.start();
      await flush();
      expect(open).toHaveBeenCalledTimes(1);
      expect(api.wake).toHaveBeenCalledTimes(1);
    });
  });

  describe('state by SSE', () => {
    it('follows the state events', async () => {
      await started();
      emit('tv.state', { ...hot, volume: 30 });
      expect(store.state()?.volume).toBe(30);
      expect(store.streamStatus()).toBe('live');
    });

    it('"hibernating" is "controle dormindo" and the buttons still work (the first command reconnects)', async () => {
      await started();
      emit('tv.state', { ...hot, connection: 'hibernating' });
      expect(store.status()).toBe('hibernating');
      expect(store.canSend()).toBe(true);
      expect(store.disabledReason()).toBeNull();
    });

    it('an offline agent is "agent-off" and disables the buttons with a reason', async () => {
      await started();
      emit('tv.state', { ...hot, agentOnline: false, connection: 'disconnected', volume: null });
      expect(store.status()).toBe('agent-off');
      expect(store.canSend()).toBe(false);
      expect(store.disabledReason()).toContain('agente da TV está desligado');
      expect(store.state()?.volume).toBeNull();
    });

    it('applies shortcut lists and ignores events it cannot read', async () => {
      await started();
      emit('tv.shortcuts', [shortcut(3), shortcut(1)]);
      expect(store.shortcuts()?.map((item) => item.position)).toEqual([1, 3]);
      emit('tv.shortcuts', 'lixo');
      emit('tv.state', 'lixo');
      expect(store.shortcuts()).toHaveLength(2);
      expect(store.state()?.volume).toBe(22);
    });

    it('shows "reconectando" on a stream error and "live" when it opens again', async () => {
      await started();
      emit('error');
      expect(store.streamStatus()).toBe('reconnecting');
      emit('open');
      expect(store.streamStatus()).toBe('live');
    });

    it('turns the watchdog event into a note with the time', async () => {
      await started();
      expect(store.watchdogNote()).toBeNull();
      emit('tv.watchdog', {
        kind: 'repaired',
        severity: 'info',
        detail: '',
        attempts: 1,
        at: new Date(2026, 9, 19, 14, 2).toISOString(),
      });
      expect(store.watchdogNote()).toBe('controle religado às 14:02');
      emit('tv.watchdog', {
        kind: 'repair_failed',
        severity: 'error',
        detail: '',
        attempts: 3,
        at: new Date(2026, 9, 19, 14, 5).toISOString(),
      });
      expect(store.watchdogNote()).toBe('reparo do controle falhou às 14:05');
      emit('tv.watchdog', {
        kind: 'port_closed',
        severity: 'warn',
        detail: '',
        attempts: 0,
        at: new Date(2026, 9, 19, 14, 6).toISOString(),
      });
      expect(store.watchdogNote()).toBeNull();
    });
  });

  describe('keys', () => {
    it('sends the key and never changes the state by itself', async () => {
      await started();
      await expect(store.sendKey('VOLUME_UP')).resolves.toBe(true);
      expect(api.sendKey).toHaveBeenCalledWith('VOLUME_UP');
      expect(store.state()?.volume).toBe(22);
      expect(store.inFlightKeys()).toBe(0);
    });

    it('counts keys waiting for an answer', async () => {
      await started();
      let release!: () => void;
      api.sendKey.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
      const pending = store.sendKey('UP');
      expect(store.inFlightKeys()).toBe(1);
      release();
      await pending;
      expect(store.inFlightKeys()).toBe(0);
    });

    it('does not send without network and says why, with the time of the last state', async () => {
      await started();
      online.set(false);
      expect(store.status()).toBe('offline');
      expect(store.canSend()).toBe(false);
      expect(store.disabledReason()).toBe(
        'Sem rede: o controle precisa de internet. Estado visto às 14:30.',
      );
      await expect(store.sendKey('OK')).resolves.toBe(false);
      expect(api.sendKey).not.toHaveBeenCalled();
    });

    it('says the server is waking up when there is network but no answer', async () => {
      await started();
      serverState.set('waking');
      expect(store.status()).toBe('waking');
      expect(store.disabledReason()).toContain('servidor está acordando');
      await expect(store.sendKey('OK')).resolves.toBe(false);
    });

    it('504 shows "a TV não respondeu" once and does not retry', async () => {
      await started();
      api.sendKey.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      await expect(store.sendKey('OK')).resolves.toBe(false);
      expect(store.notice()).toEqual({
        kind: 'error',
        text: 'A TV não respondeu a tempo. Tente de novo.',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(api.sendKey).toHaveBeenCalledTimes(1);
    });

    it('503 agent-offline marks the agent as down and disables the buttons', async () => {
      await started();
      api.sendKey.mockRejectedValueOnce(problem(503, 'agent-offline'));
      await expect(store.sendKey('OK')).resolves.toBe(false);
      expect(store.status()).toBe('agent-off');
      expect(store.canSend()).toBe(false);
      expect(store.state()?.volume).toBeNull();
      expect(api.sendKey).toHaveBeenCalledTimes(1);
    });

    it('429 shows the wait time', async () => {
      await started();
      api.sendKey.mockRejectedValueOnce(problem(429, 'rate-limited', { 'Retry-After': '9' }));
      await store.sendKey('OK');
      expect(store.notice()?.text).toBe('Comandos demais em pouco tempo. Aguarde 9 s.');
    });

    it('502 shows the message of the agent code', async () => {
      await started();
      api.sendKey.mockRejectedValueOnce(
        new HttpErrorResponse({
          status: 502,
          error: { type: `${PROBLEM}command-failed`, agentError: 'TV_UNREACHABLE' },
        }),
      );
      await store.sendKey('OK');
      expect(store.notice()?.text).toContain('A TV não respondeu ao controle');
    });

    it('clears an error notice when the next key works, and notices expire by themselves', async () => {
      await started();
      api.sendKey.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      await store.sendKey('OK');
      expect(store.notice()?.kind).toBe('error');
      await store.sendKey('OK');
      expect(store.notice()).toBeNull();

      api.sendKey.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      await store.sendKey('OK');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(store.notice()).toBeNull();
    });
  });

  describe('wake while visible', () => {
    it('wakes on opening and again every two minutes', async () => {
      await started();
      expect(api.wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(api.wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(api.wake).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.wake).toHaveBeenCalledTimes(3);
    });

    it('stops while the page is hidden and resumes (with a fresh read) when it is visible again', async () => {
      await started();
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(api.wake).toHaveBeenCalledTimes(1);

      setVisibility('visible');
      await flush();
      expect(api.wake).toHaveBeenCalledTimes(2);
      expect(api.state).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.wake).toHaveBeenCalledTimes(3);
    });

    it('does not wake on a hidden page even if called', async () => {
      setVisibility('hidden');
      await started();
      expect(api.wake).not.toHaveBeenCalled();
    });

    it('stops everything on stop: no more wake, no stream, no listeners', async () => {
      await started();
      store.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(api.wake).toHaveBeenCalledTimes(1);
      expect(events.observed).toBe(false);
      setVisibility('hidden');
      setVisibility('visible');
      await flush();
      expect(api.wake).toHaveBeenCalledTimes(1);
    });

    it('does not call the server without network, and comes back when the network does', async () => {
      online.set(false);
      await started();
      expect(api.wake).not.toHaveBeenCalled();
      expect(api.state).not.toHaveBeenCalled();
      online.set(true);
      window.dispatchEvent(new Event('online'));
      await flush();
      expect(api.state).toHaveBeenCalledTimes(1);
      expect(api.wake).toHaveBeenCalledTimes(1);
    });

    it('a failed wake that says "no agent configured" is shown, and a later good one clears it', async () => {
      api.wake.mockRejectedValueOnce(problem(503, 'agent-not-configured'));
      api.state.mockResolvedValue({ ...hot, agentOnline: false, connection: 'disconnected' });
      await started();
      expect(store.status()).toBe('unconfigured');
      expect(store.canSend()).toBe(false);
      expect(store.disabledReason()).toContain('Nenhum agente foi configurado');

      // Enquanto o agente segue fora do ar nada é aquecido; quando ele volta, o estado limpa o aviso.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.wake).toHaveBeenCalledTimes(1);
      expect(store.status()).toBe('unconfigured');
      emit('tv.state', hot);
      expect(store.status()).toBe('hot');
      expect(store.canSend()).toBe(true);
    });

    it('does not wake while the agent is known to be offline, and wakes again once it is back', async () => {
      const down = { ...hot, agentOnline: false, connection: 'disconnected' };
      api.state.mockResolvedValue(down);
      await started();
      emit('tv.state', down);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(api.wake).toHaveBeenCalledTimes(1);
      api.state.mockResolvedValue(hot);
      emit('tv.state', hot);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.wake).toHaveBeenCalledTimes(2);
    });
  });

  describe('offline with a last seen state', () => {
    it('shows the cached state with the time it was seen, disabled', async () => {
      localStorage.setItem(
        'uniover.tv.last-state',
        JSON.stringify({
          state: { ...hot, connection: 'hibernating' },
          seenAt: new Date(2026, 9, 19, 13, 7).getTime(),
          shortcuts: [shortcut(1)],
        }),
      );
      online.set(false);
      await started();
      expect(store.state()?.connection).toBe('hibernating');
      expect(store.lastKnownStatus()).toBe('hibernating');
      expect(store.status()).toBe('offline');
      expect(store.seenAtText()).toBe('13:07');
      expect(store.disabledReason()).toContain('visto às 13:07');
      expect(store.shortcuts()).toHaveLength(1);
      expect(api.state).not.toHaveBeenCalled();
    });

    it('ignores a corrupt cache and a cache when there is network', async () => {
      localStorage.setItem('uniover.tv.last-state', '{lixo');
      online.set(false);
      await started();
      expect(store.state()).toBeNull();
      expect(store.status()).toBe('offline');
    });
  });

  describe('app icons in the browser cache', () => {
    const STATE_KEY = 'uniover.tv.last-state';
    const ICONS_KEY = 'uniover.tv.app-icons';
    /** Um ícone do tamanho do teto da API: cerca de 44 mil caracteres. */
    const bigIcon = (seed: number) => `data:image/png;base64,${String(seed % 10).repeat(43_690)}`;
    const iconsStored = () =>
      JSON.parse(localStorage.getItem(ICONS_KEY) ?? '{}') as Record<string, string>;

    it('keeps the icons out of the state cache (rewritten at every volume change) and in a key of their own', async () => {
      await started();
      emit('tv.shortcuts', [
        shortcut(1, { iconDataUri: 'data:image/png;base64,AAAA' }),
        shortcut(2),
      ]);
      expect(iconsStored()).toEqual({ s1: 'data:image/png;base64,AAAA' });
      const cached = JSON.parse(localStorage.getItem(STATE_KEY)!);
      expect(cached.shortcuts.map((item: TvShortcut) => item.iconDataUri)).toEqual([null, null]);
      expect(localStorage.getItem(STATE_KEY)).not.toContain('AAAA');
      // A lista em uso na tela continua com o ícone.
      expect(store.shortcuts()?.[0].iconDataUri).toBe('data:image/png;base64,AAAA');
    });

    it('writes the icons only when the list arrives, never again for a state change or the same list', async () => {
      const set = vi.spyOn(Storage.prototype, 'setItem');
      await started();
      const iconWrites = () => set.mock.calls.filter(([key]) => key === ICONS_KEY).length;
      emit('tv.shortcuts', [shortcut(1, { iconDataUri: bigIcon(1) })]);
      const written = iconWrites();
      expect(written).toBeGreaterThan(0);
      for (const volume of [23, 24, 25, 26]) emit('tv.state', { ...hot, volume });
      emit('tv.shortcuts', [shortcut(1, { iconDataUri: bigIcon(1) })]);
      expect(iconWrites()).toBe(written);
      set.mockRestore();
    });

    it('shows the cached icons when the app opens without network', async () => {
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          state: hot,
          seenAt: new Date(2026, 9, 19, 13, 7).getTime(),
          shortcuts: [shortcut(1), shortcut(2)],
        }),
      );
      localStorage.setItem(ICONS_KEY, JSON.stringify({ s2: 'data:image/png;base64,AAAA' }));
      online.set(false);
      await started();
      expect(store.shortcuts()?.map((item) => item.iconDataUri)).toEqual([
        null,
        'data:image/png;base64,AAAA',
      ]);
    });

    it('reads a row saved before the icons existed (no field at all) as "no icon"', async () => {
      const old: Partial<TvShortcut> = shortcut(1);
      delete old.iconDataUri;
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({ state: hot, seenAt: Date.now(), shortcuts: [old] }),
      );
      online.set(false);
      await started();
      expect(store.shortcuts()).toHaveLength(1);
      expect(store.shortcuts()?.[0].iconDataUri).toBeNull();
    });

    it('reads a cached shortcut saved before "installed" existed as installed when it was active, and not otherwise', async () => {
      const legacy = (position: number, enabled: boolean): Partial<TvShortcut> => {
        const item: Partial<TvShortcut> = shortcut(position, { enabled });
        delete item.installed;
        return item;
      };
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          state: hot,
          seenAt: Date.now(),
          shortcuts: [legacy(1, true), legacy(2, false)],
        }),
      );
      online.set(false);
      await started();
      expect(store.shortcuts()?.map((item) => item.installed)).toEqual([true, false]);
    });

    it('survives a corrupt icon cache: the shortcuts and the state still come back, just without icons', async () => {
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({ state: hot, seenAt: Date.now(), shortcuts: [shortcut(1)] }),
      );
      localStorage.setItem(ICONS_KEY, '{lixo');
      online.set(false);
      await started();
      expect(store.state()).not.toBeNull();
      expect(store.shortcuts()?.[0].iconDataUri).toBeNull();
    });

    it('stores a full list of 100 maximum-size icons within the cap, state included', async () => {
      await started();
      emit(
        'tv.shortcuts',
        Array.from({ length: 100 }, (_, index) =>
          shortcut(index + 1, { iconDataUri: bigIcon(index) }),
        ),
      );
      const stored = iconsStored();
      const chars = Object.values(stored).reduce((sum, uri) => sum + uri.length, 0);
      expect(chars).toBeLessThanOrEqual(ICONS_CACHE_MAX_CHARS);
      expect(Object.keys(stored).length).toBeGreaterThan(15);
      expect(Object.keys(stored).length).toBeLessThan(100);
      // O estado, que é o que vale sem rede, continua pequeno e gravado.
      expect(localStorage.getItem(STATE_KEY)!.length).toBeLessThan(30_000);
      // E a tela em uso tem os 100 ícones.
      expect(store.shortcuts()?.filter((item) => item.iconDataUri)).toHaveLength(100);
    });

    it('still keeps the state cache when the browser has no room for the icons', async () => {
      const original = Storage.prototype.setItem;
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key === ICONS_KEY) throw new DOMException('cheio', 'QuotaExceededError');
        original.call(this, key, value);
      });
      await started();
      emit('tv.shortcuts', [shortcut(1, { iconDataUri: bigIcon(1) }), shortcut(2)]);
      expect(store.shortcuts()).toHaveLength(2);
      expect(JSON.parse(localStorage.getItem(STATE_KEY)!).shortcuts).toHaveLength(2);
      expect(localStorage.getItem(ICONS_KEY)).toBeNull();
      set.mockRestore();
    });
  });

  describe('power off', () => {
    it('asks once, with no passkey step, and tells the TV will not come back by itself', async () => {
      await started();
      await expect(store.powerOff()).resolves.toBeNull();
      expect(api.powerOff).toHaveBeenCalledTimes(1);
      expect(store.notice()?.text).toContain('A TV só volta com o controle original');
    });

    it('returns the failure so the sheet can show it, and never repeats the request', async () => {
      await started();
      api.powerOff.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      const failure = await store.powerOff();
      expect(failure?.kind).toBe('timeout');
      expect(failure?.message).toContain('A TV não respondeu a tempo');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.powerOff).toHaveBeenCalledTimes(1);
    });

    it('a 403 is just a failure: there is no step-up path', async () => {
      await started();
      api.powerOff.mockRejectedValueOnce(problem(403, 'step-up-required'));
      const failure = await store.powerOff();
      expect(failure).not.toBeNull();
      expect(api.powerOff).toHaveBeenCalledTimes(1);
    });

    it('does not call the API when the buttons are disabled', async () => {
      await started();
      online.set(false);
      const failure = await store.powerOff();
      expect(failure?.message).toContain('Sem rede');
      expect(api.powerOff).not.toHaveBeenCalled();
    });
  });

  describe('text', () => {
    it('validates before calling the API, without a toast', async () => {
      await started();
      for (const text of ['', 'a\nb', 'a'.repeat(201)]) {
        const failure = await store.sendText(text);
        expect(failure?.kind).toBe('invalid');
        expect(failure?.message).toContain('de 1 a 200 caracteres');
      }
      expect(api.sendText).not.toHaveBeenCalled();
      expect(store.notice()).toBeNull();
    });

    it('sends valid text, counting characters (not UTF-16 units), and stays quiet', async () => {
      await started();
      expect(isValidTvText('😀'.repeat(200))).toBe(true);
      expect(isValidTvText('😀'.repeat(201))).toBe(false);
      await expect(store.sendText('batman')).resolves.toBeNull();
      expect(api.sendText).toHaveBeenCalledWith('batman');
      expect(store.notice()).toBeNull();
    });

    it('returns the failure without a toast and learns that the agent is off', async () => {
      await started();
      api.sendText.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      const timeout = await store.sendText('batman');
      expect(timeout?.kind).toBe('timeout');
      expect(store.notice()).toBeNull();

      api.sendText.mockRejectedValueOnce(problem(503, 'agent-offline'));
      expect((await store.sendText('batman'))?.kind).toBe('agent-offline');
      expect(store.state()?.agentOnline).toBe(false);
    });

    it('does not call the API while the remote cannot send', async () => {
      await started();
      online.set(false);
      const failure = await store.sendText('batman');
      expect(failure?.kind).toBe('agent-offline');
      expect(api.sendText).not.toHaveBeenCalled();
    });
  });

  describe('shortcuts', () => {
    it('launches an app in the control and names it by "Atalho n"', async () => {
      await started();
      await expect(store.launch(shortcut(2))).resolves.toBe(true);
      expect(api.launch).toHaveBeenCalledWith('s2');
      expect(store.notice()?.text).toBe('Atalho 2 aberto na TV.');
    });

    it('launches an installed app that is out of the control: pinning only decides the row of shortcuts', async () => {
      await started();
      await expect(store.launch(shortcut(2, { enabled: false, installed: true }))).resolves.toBe(
        true,
      );
      expect(api.launch).toHaveBeenCalledWith('s2');
    });

    it('does not launch an app that left the TV', async () => {
      await started();
      await expect(store.launch(shortcut(2, { enabled: false, installed: false }))).resolves.toBe(
        false,
      );
      expect(api.launch).not.toHaveBeenCalled();
    });

    it('does not launch while the remote cannot send, whatever the app', async () => {
      await started();
      online.set(false);
      await expect(store.launch(shortcut(2))).resolves.toBe(false);
      expect(api.launch).not.toHaveBeenCalled();
    });

    it('refreshes the list through the API and reads it again', async () => {
      await started();
      api.shortcuts.mockResolvedValue([shortcut(1), shortcut(2), shortcut(3)]);
      await expect(store.refreshShortcuts()).resolves.toBe(true);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(store.shortcuts()).toHaveLength(3);
      expect(store.notice()?.text).toBe('Lista de apps atualizada.');
    });

    it('renames and hides, replacing the item with what the API returned', async () => {
      await started();
      api.updateShortcut.mockResolvedValueOnce(shortcut(1, { customLabel: 'Sala' }));
      await expect(store.renameShortcut('s1', 'Sala')).resolves.toBe(true);
      expect(api.updateShortcut).toHaveBeenCalledWith('s1', { customLabel: 'Sala' });
      expect(store.shortcuts()?.[0].customLabel).toBe('Sala');

      api.updateShortcut.mockResolvedValueOnce(shortcut(2, { enabled: false }));
      await expect(store.setShortcutEnabled('s2', false)).resolves.toBe(true);
      expect(store.shortcuts()?.[1].enabled).toBe(false);
    });

    it('does not edit without network', async () => {
      await started();
      online.set(false);
      await expect(store.renameShortcut('s1', 'Sala')).resolves.toBe(false);
      expect(api.updateShortcut).not.toHaveBeenCalled();
      expect(store.notice()?.kind).toBe('error');
    });
  });
});
