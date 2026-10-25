import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ConnectivityService, ServerState } from '../../../core/connectivity/connectivity.service';
import { SessionState } from '../../../core/session/session-state';
import { StreamEvent, StreamService } from '../../../core/sse/stream.service';
import { TvApi } from './tv-api';
import { TvSelection } from './tv-selection';
import { ICONS_CACHE_MAX_CHARS, TvStore, isValidTvText } from './tv-store';
import { TvShortcut, TvSummary } from './tv-types';

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
    tvs: vi.fn(),
    state: vi.fn(),
    shortcuts: vi.fn(),
    wake: vi.fn(),
    sendKey: vi.fn(),
    sendText: vi.fn(),
    powerOff: vi.fn(),
    launch: vi.fn(),
    cleanup: vi.fn(),
    refreshShortcuts: vi.fn(),
    updateShortcut: vi.fn(),
    reorderShortcuts: vi.fn(),
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
    api.powerOff.mockResolvedValue('sent');
    api.launch.mockResolvedValue(undefined);
    api.cleanup.mockResolvedValue({
      ok: true,
      latencyMs: 9000,
      closedApps: 6,
      freedMb: 383,
      memoryBeforeMb: 214,
      memoryAfterMb: 597,
      failedSteps: [],
    });
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

    describe('with an agent that powers off after reading', () => {
      const safeTv: TvSummary = {
        id: 'sala',
        name: 'Sala',
        isDefault: true,
        agentSlug: null,
        kind: 'android',
        online: true,
        capabilities: ['tv.remote', 'tv.kind.android', 'tv.power.off.v1'],
      };

      it('asks for the safe power off, and says the TV is off once the agent confirmed it', async () => {
        api.tvs.mockResolvedValue([safeTv]);
        api.powerOff.mockResolvedValueOnce('off');
        await started();
        expect(store.safePowerOff()).toBe(true);
        await expect(store.powerOff()).resolves.toBeNull();
        expect(api.powerOff).toHaveBeenCalledWith(true);
        expect(store.notice()?.text).toBe('TV desligada. Ela só volta com o controle original.');
      });

      it('tells the TV was already off instead of calling it an error', async () => {
        api.tvs.mockResolvedValue([safeTv]);
        api.powerOff.mockResolvedValueOnce('already_off');
        await started();
        await expect(store.powerOff()).resolves.toBeNull();
        expect(store.notice()).toEqual({
          kind: 'info',
          text: 'A TV já estava desligada. Nenhuma tecla foi enviada.',
        });
      });

      it('returns the agent reason to the sheet and never repeats the request', async () => {
        api.tvs.mockResolvedValue([safeTv]);
        api.powerOff.mockRejectedValueOnce(
          new HttpErrorResponse({
            status: 502,
            error: { type: PROBLEM + 'command-failed', status: 502, agentError: 'uncertain' },
          }),
        );
        await started();
        const failure = await store.powerOff();
        expect(failure?.kind).toBe('command-failed');
        expect(failure?.message).toContain('a tecla não foi repetida');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.powerOff).toHaveBeenCalledTimes(1);
      });

      it('an agent without the capability keeps the request of before', async () => {
        api.tvs.mockResolvedValue([{ ...safeTv, capabilities: ['tv.remote', 'tv.kind.android'] }]);
        await started();
        expect(store.safePowerOff()).toBe(false);
        await expect(store.powerOff()).resolves.toBeNull();
        expect(api.powerOff).toHaveBeenCalledWith(false);
        expect(store.notice()?.text).toContain('Pedido de desligar enviado');
      });

      it('without the list of TVs it also keeps the request of before', async () => {
        api.tvs.mockRejectedValue(problem(404));
        await started();
        expect(store.safePowerOff()).toBe(false);
        await store.powerOff();
        expect(api.powerOff).toHaveBeenCalledWith(false);
      });
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
      for (const text of ['a\nb', 'a'.repeat(201)]) {
        const failure = await store.sendText(text);
        expect(failure?.kind).toBe('invalid');
        expect(failure?.message).toContain('até 200 caracteres');
      }
      expect(api.sendText).not.toHaveBeenCalled();
      expect(store.notice()).toBeNull();
    });

    it('sends the empty text: it erases what the agent typed on the TV', async () => {
      await started();
      expect(isValidTvText('')).toBe(true);
      await expect(store.sendText('')).resolves.toBeNull();
      expect(api.sendText).toHaveBeenCalledWith('');
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

  describe('cleanup', () => {
    it('asks the API once and says what was done, in the notice pattern of the module', async () => {
      await started();
      await expect(store.cleanup()).resolves.toBe(true);
      expect(api.cleanup).toHaveBeenCalledTimes(1);
      expect(store.notice()).toEqual({
        kind: 'info',
        text: 'Fechou 6 apps e liberou cerca de 380 MB.',
      });
      expect(store.cleaning()).toBe(false);
    });

    it('is "cleaning" while it waits and the rest of the control keeps working', async () => {
      await started();
      let finish: (value: unknown) => void = () => undefined;
      api.cleanup.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const pending = store.cleanup();
      expect(store.cleaning()).toBe(true);
      // Uma tecla enviada no meio da limpeza passa normalmente (nada trava).
      await expect(store.sendKey('HOME')).resolves.toBe(true);
      expect(api.sendKey).toHaveBeenCalledTimes(1);
      expect(store.canSend()).toBe(true);
      finish({
        ok: true,
        latencyMs: 1,
        closedApps: 0,
        freedMb: null,
        memoryBeforeMb: null,
        memoryAfterMb: null,
        failedSteps: [],
      });
      await expect(pending).resolves.toBe(true);
      expect(store.cleaning()).toBe(false);
    });

    it('one request at a time: a second one while it runs does nothing', async () => {
      await started();
      let finish: (value: unknown) => void = () => undefined;
      api.cleanup.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const first = store.cleanup();
      await expect(store.cleanup()).resolves.toBe(false);
      expect(api.cleanup).toHaveBeenCalledTimes(1);
      finish({
        ok: true,
        latencyMs: 1,
        closedApps: 1,
        freedMb: null,
        memoryBeforeMb: null,
        memoryAfterMb: null,
        failedSteps: [],
      });
      await first;
      // Terminada a primeira, outra pode ser pedida.
      await expect(store.cleanup()).resolves.toBe(true);
      expect(api.cleanup).toHaveBeenCalledTimes(2);
    });

    it('does not call the API while the remote cannot send', async () => {
      await started();
      online.set(false);
      await expect(store.cleanup()).resolves.toBe(false);
      expect(api.cleanup).not.toHaveBeenCalled();
      expect(store.cleaning()).toBe(false);
    });

    it('does not call the API without an agent', async () => {
      await started();
      emit('tv.state', { ...hot, agentOnline: false, connection: 'disconnected' });
      await flush();
      expect(store.canSend()).toBe(false);
      await expect(store.cleanup()).resolves.toBe(false);
      expect(api.cleanup).not.toHaveBeenCalled();
    });

    it('says when there was nothing to close', async () => {
      await started();
      api.cleanup.mockResolvedValueOnce({
        ok: true,
        latencyMs: 1,
        closedApps: 0,
        freedMb: 3,
        memoryBeforeMb: 500,
        memoryAfterMb: 503,
        failedSteps: [],
      });
      await store.cleanup();
      expect(store.notice()?.text).toBe('Nada para fechar.');
    });

    it('shows each error with a useful message, once, and never repeats the request', async () => {
      await started();
      api.cleanup.mockRejectedValueOnce(
        new HttpErrorResponse({
          status: 502,
          error: { type: PROBLEM + 'command-failed', status: 502, agentError: 'adb_unreachable' },
        }),
      );
      await expect(store.cleanup()).resolves.toBe(false);
      expect(store.notice()).toEqual({
        kind: 'error',
        text: 'A TV não respondeu pelo ADB agora. Tente de novo com a TV ligada.',
      });

      api.cleanup.mockRejectedValueOnce(problem(504, 'agent-timeout'));
      await store.cleanup();
      expect(store.notice()?.text).toContain('A limpeza demorou mais do que o esperado');

      api.cleanup.mockRejectedValueOnce(problem(409, 'cleanup-in-progress'));
      await store.cleanup();
      expect(store.notice()?.text).toBe(
        'Já há uma limpeza da TV em andamento. Aguarde ela terminar.',
      );

      api.cleanup.mockRejectedValueOnce(problem(429, 'rate-limited', { 'Retry-After': '4' }));
      await store.cleanup();
      expect(store.notice()?.text).toBe('Comandos demais em pouco tempo. Aguarde 4 s.');

      expect(api.cleanup).toHaveBeenCalledTimes(4);
      expect(store.cleaning()).toBe(false);
    });

    it('learns the agent is off when the server says so', async () => {
      await started();
      api.cleanup.mockRejectedValueOnce(problem(503, 'agent-offline'));
      await store.cleanup();
      expect(store.notice()?.text).toContain('O agente da TV está desligado');
      expect(store.state()?.agentOnline).toBe(false);
      expect(store.canSend()).toBe(false);
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

  describe('reordering the shortcuts', () => {
    const STATE_KEY = 'uniover.tv.last-state';
    const ICONS_KEY = 'uniover.tv.app-icons';
    const order = () => store.shortcuts()?.map((item) => item.id);
    /** A lista como o servidor a devolve depois de gravar a ordem: os mesmos atalhos, renumerados de 1 a n. */
    const confirmed = (...ids: string[]) =>
      ids.map((id, index) => shortcut(Number(id.slice(1)), { position: index + 1 }));
    const pending = () => {
      let settle!: (list: TvShortcut[]) => void;
      const promise = new Promise<TvShortcut[]>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    };

    beforeEach(async () => {
      api.shortcuts.mockResolvedValue([shortcut(1), shortcut(2), shortcut(3)]);
      await started();
    });

    it('shows the new order at once, before the server answers, with the positions renumbered', async () => {
      const send = pending();
      api.reorderShortcuts.mockReturnValueOnce(send.promise);

      const done = store.reorder(['s3', 's1', 's2']);

      expect(order()).toEqual(['s3', 's1', 's2']);
      expect(store.shortcuts()?.map((item) => item.position)).toEqual([1, 2, 3]);
      expect(api.reorderShortcuts).toHaveBeenCalledWith(['s3', 's1', 's2']);
      send.settle(confirmed('s3', 's1', 's2'));
      await expect(done).resolves.toBe(true);
      expect(order()).toEqual(['s3', 's1', 's2']);
      expect(store.notice()).toBeNull();
    });

    it('keeps everything else about a shortcut (name, icon, whether it is in the control)', async () => {
      api.shortcuts.mockResolvedValue([
        shortcut(1, { customLabel: 'Sala', iconDataUri: 'data:image/png;base64,AAAA' }),
        shortcut(2, { enabled: false }),
      ]);
      await store.refresh();
      api.reorderShortcuts.mockReturnValueOnce(pending().promise);

      void store.reorder(['s2', 's1']);

      expect(store.shortcuts()?.[1]).toMatchObject({
        id: 's1',
        customLabel: 'Sala',
        iconDataUri: 'data:image/png;base64,AAAA',
      });
      expect(store.shortcuts()?.[0]).toMatchObject({ id: 's2', enabled: false });
    });

    it('goes back to the last order the server confirmed, says it was not saved, and reads the list again', async () => {
      api.reorderShortcuts.mockRejectedValueOnce(problem(400, 'validation-failed'));
      // A leitura de conferência não volta (ainda): a volta da ordem não pode depender dela.
      api.shortcuts.mockReturnValueOnce(new Promise(() => undefined));

      const done = store.reorder(['s3', 's1', 's2']);
      expect(order()).toEqual(['s3', 's1', 's2']);

      await expect(done).resolves.toBe(false);
      expect(order()).toEqual(['s1', 's2', 's3']);
      expect(store.shortcuts()?.map((item) => item.position)).toEqual([1, 2, 3]);
      expect(store.notice()).toEqual({
        kind: 'error',
        text: 'Não foi possível salvar a nova ordem. Ela voltou ao que era.',
      });
      await flush();
      expect(api.shortcuts).toHaveBeenCalledTimes(2);
    });

    it('says the real cause when it is the network, the session or the limit', async () => {
      for (const [error, text] of [
        [problem(0), 'Sem conexão com o servidor. Confira a internet.'],
        [problem(401), 'Sua sessão acabou. Entre de novo para controlar a TV.'],
        [problem(429), 'Comandos demais em pouco tempo. Aguarde um pouco.'],
      ] as const) {
        api.reorderShortcuts.mockRejectedValueOnce(error);
        await expect(store.reorder(['s2', 's1', 's3'])).resolves.toBe(false);
        expect(store.notice()?.text).toBe(text);
        expect(order()).toEqual(['s1', 's2', 's3']);
      }
    });

    it('joins the taps made while a send is going: the newest order goes out right after, and once', async () => {
      const first = pending();
      api.reorderShortcuts
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(confirmed('s3', 's2', 's1'));

      const a = store.reorder(['s2', 's1', 's3']);
      const b = store.reorder(['s2', 's3', 's1']);
      const c = store.reorder(['s3', 's2', 's1']);

      expect(api.reorderShortcuts).toHaveBeenCalledTimes(1);
      expect(order()).toEqual(['s3', 's2', 's1']);
      first.settle(confirmed('s2', 's1', 's3'));
      await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);

      expect(api.reorderShortcuts).toHaveBeenCalledTimes(2);
      expect(api.reorderShortcuts).toHaveBeenLastCalledWith(['s3', 's2', 's1']);
      expect(order()).toEqual(['s3', 's2', 's1']);
    });

    it('does not flash back to an older order while the newest is still on its way', async () => {
      const first = pending();
      const second = pending();
      api.reorderShortcuts.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const done = store.reorder(['s2', 's1', 's3']);
      void store.reorder(['s3', 's2', 's1']);
      first.settle(confirmed('s2', 's1', 's3'));
      await flush();

      // O primeiro envio voltou, o segundo ainda não: a tela fica no pedido mais novo.
      expect(order()).toEqual(['s3', 's2', 's1']);
      second.settle(confirmed('s3', 's2', 's1'));
      await done;
      expect(order()).toEqual(['s3', 's2', 's1']);
    });

    it('goes back to what the earlier send confirmed when a later one in the chain is refused', async () => {
      const first = pending();
      api.reorderShortcuts
        .mockReturnValueOnce(first.promise)
        .mockRejectedValueOnce(problem(400, 'validation-failed'));

      // A leitura que vem depois da recusa já traz o que o servidor guardou: a ordem do primeiro envio.
      api.shortcuts.mockResolvedValue(confirmed('s2', 's1', 's3'));

      const done = store.reorder(['s2', 's1', 's3']);
      void store.reorder(['s3', 's2', 's1']);
      first.settle(confirmed('s2', 's1', 's3'));

      await expect(done).resolves.toBe(false);
      expect(order()).toEqual(['s2', 's1', 's3']);
      await flush();
      expect(order()).toEqual(['s2', 's1', 's3']);
    });

    it('holds a list that arrives from the stream while sending, so it does not undo the new order', async () => {
      const send = pending();
      api.reorderShortcuts.mockReturnValueOnce(send.promise);
      api.shortcuts.mockResolvedValue(confirmed('s3', 's1', 's2'));

      const done = store.reorder(['s3', 's1', 's2']);
      emit('tv.shortcuts', [shortcut(1), shortcut(2), shortcut(3)]);

      expect(order()).toEqual(['s3', 's1', 's2']);
      send.settle(confirmed('s3', 's1', 's2'));
      await done;
      await flush();
      expect(order()).toEqual(['s3', 's1', 's2']);
      // O que chegou não era o que o servidor acabou de confirmar: a lista certa foi buscada de novo.
      expect(api.shortcuts).toHaveBeenCalledTimes(2);
    });

    it('needs no second read when the held list is exactly what the server confirmed (its own echo)', async () => {
      const send = pending();
      api.reorderShortcuts.mockReturnValueOnce(send.promise);

      const done = store.reorder(['s3', 's1', 's2']);
      emit('tv.shortcuts', confirmed('s3', 's1', 's2'));
      send.settle(confirmed('s3', 's1', 's2'));
      await done;
      await flush();

      expect(order()).toEqual(['s3', 's1', 's2']);
      expect(api.shortcuts).toHaveBeenCalledTimes(1);
    });

    it('applies a list from the stream as usual when nothing is being sent', () => {
      emit('tv.shortcuts', confirmed('s2', 's3', 's1'));
      expect(order()).toEqual(['s2', 's3', 's1']);
    });

    it('refuses a list that is not an exact permutation of the shortcuts it has, without calling the API', async () => {
      for (const ids of [['s1', 's2'], ['s1', 's1', 's2'], ['s1', 's2', 's9'], []]) {
        await expect(store.reorder(ids)).resolves.toBe(false);
      }
      expect(api.reorderShortcuts).not.toHaveBeenCalled();
      expect(order()).toEqual(['s1', 's2', 's3']);
    });

    it('does not reorder without network, and says why', async () => {
      online.set(false);

      await expect(store.reorder(['s3', 's1', 's2'])).resolves.toBe(false);

      expect(api.reorderShortcuts).not.toHaveBeenCalled();
      expect(order()).toEqual(['s1', 's2', 's3']);
      expect(store.notice()?.kind).toBe('error');
    });

    it('does not need the agent: it works with the agent off', async () => {
      emit('tv.state', { ...hot, agentOnline: false, connection: 'disconnected' });
      api.reorderShortcuts.mockResolvedValueOnce(confirmed('s2', 's1', 's3'));

      await expect(store.reorder(['s2', 's1', 's3'])).resolves.toBe(true);
    });

    it('keeps the new order in the cache the offline view reads', async () => {
      api.reorderShortcuts.mockResolvedValueOnce(confirmed('s3', 's1', 's2'));

      await store.reorder(['s3', 's1', 's2']);

      const cached = JSON.parse(localStorage.getItem(STATE_KEY)!);
      expect(cached.shortcuts.map((item: TvShortcut) => item.id)).toEqual(['s3', 's1', 's2']);
    });

    it('does not rewrite the cached icons just because the order changed', async () => {
      const withIcons = (...ids: string[]) =>
        confirmed(...ids).map((item) => ({
          ...item,
          iconDataUri: item.id === 's3' ? null : `data:image/png;base64,${item.id}`,
        }));
      api.shortcuts.mockResolvedValue(withIcons('s1', 's2', 's3'));
      await store.refresh();
      const set = vi.spyOn(Storage.prototype, 'setItem');
      api.reorderShortcuts.mockResolvedValueOnce(withIcons('s3', 's2', 's1'));

      await store.reorder(['s3', 's2', 's1']);

      expect(set.mock.calls.filter(([key]) => key === ICONS_KEY)).toHaveLength(0);
      set.mockRestore();
    });
  });

  describe('permissions', () => {
    const grant = (...permissions: string[]) => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'guest',
        permissions,
      });
      TestBed.tick();
    };
    const noCallsToTheServer = () => {
      for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    };

    afterEach(() => localStorage.clear());

    it('without module:tv it opens nothing: no stream, no state, no shortcuts, no wake', async () => {
      grant('module:training');
      await started();
      expect(open).not.toHaveBeenCalled();
      noCallsToTheServer();
      await vi.advanceTimersByTimeAsync(600_000);
      setVisibility('hidden');
      setVisibility('visible');
      window.dispatchEvent(new Event('online'));
      await flush();
      expect(open).not.toHaveBeenCalled();
      noCallsToTheServer();
    });

    it('with only module:tv it reads (stream, state, shortcuts) but never wakes, on any path', async () => {
      grant('module:tv');
      await started();
      expect(open).toHaveBeenCalledTimes(1);
      expect(api.state).toHaveBeenCalledTimes(1);
      expect(api.shortcuts).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120_000);
      setVisibility('hidden');
      setVisibility('visible');
      window.dispatchEvent(new Event('online'));
      await flush();
      // O fluxo e a leitura periódica continuam; o "aquecer", que a API recusaria, nunca sai.
      expect(api.state.mock.calls.length).toBeGreaterThan(1);
      expect(api.wake).not.toHaveBeenCalled();
    });

    it('with tv:control it wakes on opening, on every round and when the page is visible again', async () => {
      grant('module:tv', 'tv:control');
      await started();
      expect(api.wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.wake).toHaveBeenCalledTimes(2);
      setVisibility('hidden');
      setVisibility('visible');
      await flush();
      expect(api.wake).toHaveBeenCalledTimes(3);
    });

    it('a guest with tv:control cannot power off, launch, refresh the list or edit the shortcuts', async () => {
      grant('module:tv', 'tv:control');
      await started();
      await expect(store.sendKey('MUTE')).resolves.toBe(true);
      await expect(store.sendText('oi')).resolves.toBeNull();
      await expect(store.cleanup()).resolves.toBe(true);

      const power = await store.powerOff();
      expect(power?.kind).toBe('forbidden');
      expect(power?.message).toBe('Você não tem permissão para fazer isso na TV.');
      await expect(store.launch(shortcut(1))).resolves.toBe(false);
      await expect(store.refreshShortcuts()).resolves.toBe(false);
      await expect(store.renameShortcut('s1', 'Novo')).resolves.toBe(false);
      await expect(store.setShortcutEnabled('s1', false)).resolves.toBe(false);
      await expect(store.reorder(['s2', 's1'])).resolves.toBe(false);

      expect(api.powerOff).not.toHaveBeenCalled();
      expect(api.launch).not.toHaveBeenCalled();
      expect(api.refreshShortcuts).not.toHaveBeenCalled();
      expect(api.updateShortcut).not.toHaveBeenCalled();
      expect(api.reorderShortcuts).not.toHaveBeenCalled();
    });

    it('a guest with only the view sends no key, no text and no cleanup, and says nothing about it', async () => {
      grant('module:tv');
      await started();
      await expect(store.sendKey('MUTE')).resolves.toBe(false);
      expect((await store.sendText('oi'))?.kind).toBe('forbidden');
      await expect(store.cleanup()).resolves.toBe(false);
      expect(api.sendKey).not.toHaveBeenCalled();
      expect(api.sendText).not.toHaveBeenCalled();
      expect(api.cleanup).not.toHaveBeenCalled();
      // Recusar aqui é silencioso: nenhum aviso de erro por algo que a tela nem oferece.
      expect(store.notice()).toBeNull();
    });

    it('launch, refresh and edit each need their own permission', async () => {
      grant('module:tv', 'tv:launch', 'tv:edit-shortcuts');
      await started();
      await expect(store.launch(shortcut(1))).resolves.toBe(true);
      await expect(store.refreshShortcuts()).resolves.toBe(true);
      api.updateShortcut.mockResolvedValue(shortcut(1, { customLabel: 'Novo' }));
      await expect(store.renameShortcut('s1', 'Novo')).resolves.toBe(true);
      expect(api.launch).toHaveBeenCalledTimes(1);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(api.updateShortcut).toHaveBeenCalledTimes(1);
    });

    it('power needs tv:power and nothing else', async () => {
      grant('module:tv', 'tv:power');
      await started();
      await expect(store.powerOff()).resolves.toBeNull();
      expect(api.powerOff).toHaveBeenCalledTimes(1);
    });

    it('the owner does everything, with no list needed', async () => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'owner',
      });
      TestBed.tick();
      await started();
      expect(api.wake).toHaveBeenCalledTimes(1);
      await expect(store.powerOff()).resolves.toBeNull();
    });

    it('follows the session: gaining the control wakes at once, losing the view closes the stream, getting it back reopens', async () => {
      grant('module:tv');
      await started();
      expect(api.wake).not.toHaveBeenCalled();

      grant('module:tv', 'tv:control');
      await flush();
      expect(api.wake).toHaveBeenCalledTimes(1);
      // Outra lista com o controle já ligado não aquece de novo.
      grant('module:tv', 'tv:control', 'tv:power');
      await flush();
      expect(api.wake).toHaveBeenCalledTimes(1);

      grant('module:training');
      await flush();
      expect(events.observed).toBe(false);
      const reads = api.state.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      setVisibility('hidden');
      setVisibility('visible');
      await flush();
      expect(api.state.mock.calls.length).toBe(reads);
      expect(api.wake).toHaveBeenCalledTimes(1);

      grant('module:tv', 'tv:control');
      await flush();
      expect(open).toHaveBeenCalledTimes(2);
      expect(events.observed).toBe(true);
      expect(api.wake).toHaveBeenCalledTimes(2);
    });
  });

  describe('several TVs', () => {
    const tvOf = (id: string, isDefault = false, extra: Partial<TvSummary> = {}): TvSummary => ({
      id,
      name: id,
      isDefault,
      agentSlug: null,
      kind: 'android',
      online: true,
      capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
      ...extra,
    });
    const CASA = tvOf('casa', true);
    const AMIGO = tvOf('amigo');
    const selection = () => TestBed.inject(TvSelection);
    /** Uma promessa que o teste resolve quando quiser (a resposta que demora). */
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      return { promise, resolve, reject };
    };

    afterEach(() => localStorage.clear());

    it('keeps the plain events path with a single TV', async () => {
      api.tvs.mockResolvedValue([CASA]);
      await started();
      expect(open.mock.calls[0][0]).toBe('/api/v1/tv/events');
      expect(store.multiple()).toBe(false);
    });

    it('keeps the plain events path when the list of TVs cannot be read', async () => {
      api.tvs.mockRejectedValue(problem(404));
      await started();
      expect(store.tvs()).toBeNull();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe('/api/v1/tv/events');
      expect(store.state()?.volume).toBe(22);
    });

    it('adopts the first TV of the list without reopening the stream the server already chose', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      expect(store.multiple()).toBe(true);
      expect(store.selectedTv()?.id).toBe('casa');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe('/api/v1/tv/events');
      expect(store.state()?.volume).toBe(22);
    });

    it('opens the stream already on the TV the person had chosen', async () => {
      selection().setTvs([CASA, AMIGO]);
      selection().select('amigo');
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe('/api/v1/tv/events?tvId=amigo');
      expect(store.selectedTv()?.id).toBe('amigo');
    });

    it('switching erases what was known about the previous TV at once and reopens the stream on the new one', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      expect(store.shortcuts()).not.toBeNull();
      const gate = deferred<TvShortcut[]>();
      api.shortcuts.mockReturnValueOnce(gate.promise);

      store.selectTv('amigo');
      // Nada da TV anterior aparece na nova enquanto ela não responde.
      expect(store.state()).toBeNull();
      expect(store.shortcuts()).toBeNull();
      expect(store.status()).toBe('loading');
      expect(store.selectedTv()?.id).toBe('amigo');
      expect(open).toHaveBeenCalledTimes(2);
      expect(open.mock.calls[1][0]).toBe('/api/v1/tv/events?tvId=amigo');

      gate.resolve([shortcut(7)]);
      await flush();
      expect(store.shortcuts()?.map((item) => item.id)).toEqual(['s7']);
      expect(store.status()).toBe('hot');
    });

    it('does nothing when the chosen TV is the one already in use', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      store.selectTv('casa');
      await flush();
      expect(open).toHaveBeenCalledTimes(1);
      expect(store.state()).not.toBeNull();
    });

    it('never paints on the new TV what the previous one answers late', async () => {
      selection().setTvs([CASA, AMIGO]);
      const lateState = deferred<unknown>();
      const lateShortcuts = deferred<TvShortcut[]>();
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      api.state.mockReturnValueOnce(lateState.promise);
      api.shortcuts.mockReturnValueOnce(lateShortcuts.promise);
      await started();

      api.shortcuts.mockResolvedValue([shortcut(5)]);
      store.selectTv('amigo');
      await flush();
      expect(store.shortcuts()?.map((item) => item.id)).toEqual(['s5']);

      lateState.resolve({ ...hot, volume: 99 });
      lateShortcuts.resolve([shortcut(9)]);
      await flush();
      expect(store.shortcuts()?.map((item) => item.id)).toEqual(['s5']);
      expect(store.state()?.volume).toBe(22);
    });

    it('does not show on the new TV the error of a key sent to the previous one', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      const gate = deferred<void>();
      api.sendKey.mockReturnValueOnce(gate.promise);
      const sending = store.sendKey('HOME');
      store.selectTv('amigo');
      await flush();
      gate.reject(problem(500));
      await expect(sending).resolves.toBe(false);
      expect(store.notice()).toBeNull();
      expect(store.inFlightKeys()).toBe(0);
    });

    it('drops the order being saved for the previous TV instead of painting it on the new one', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      const gate = deferred<TvShortcut[]>();
      api.reorderShortcuts.mockReturnValueOnce(gate.promise);
      const saving = store.reorder(['s2', 's1']);
      api.shortcuts.mockResolvedValue([shortcut(7)]);
      store.selectTv('amigo');
      await flush();

      gate.resolve([shortcut(2), shortcut(1)]);
      await expect(saving).resolves.toBe(false);
      await flush();
      expect(store.shortcuts()?.map((item) => item.id)).toEqual(['s7']);
      expect(store.notice()).toBeNull();
    });

    it('stamps the last state it keeps with the TV it belongs to', async () => {
      selection().setTvs([CASA, AMIGO]);
      selection().select('amigo');
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      expect(JSON.parse(localStorage.getItem('uniover.tv.last-state') ?? 'null').tv).toBe('amigo');
    });

    it('shows offline only the last state of the TV in use, never the one of another', async () => {
      const cached = (tv: string | null) =>
        JSON.stringify({ tv, state: hot, seenAt: Date.now() - 60_000, shortcuts: [shortcut(1)] });
      online.set(false);
      selection().setTvs([CASA, AMIGO]);

      // A TV padrão, com o guardado de outra TV: nada vale.
      localStorage.setItem('uniover.tv.last-state', cached('amigo'));
      store.start();
      await flush();
      expect(store.state()).toBeNull();
      expect(store.shortcuts()).toBeNull();
      store.stop();

      // A TV padrão com o guardado dela (ou de antes de haver várias, sem o campo): vale.
      localStorage.setItem('uniover.tv.last-state', cached(null));
      store.start();
      await flush();
      expect(store.state()?.volume).toBe(22);
    });

    it('reads the list again when the agent comes back, because its capabilities arrive with its hello', async () => {
      api.tvs.mockResolvedValue([CASA, AMIGO]);
      await started();
      const reads = api.tvs.mock.calls.length;
      emit('tv.state', { ...hot, agentOnline: false });
      await flush();
      expect(api.tvs.mock.calls.length).toBe(reads);
      emit('tv.state', hot);
      await flush();
      expect(api.tvs.mock.calls.length).toBe(reads + 1);
    });

    it('does not offer cleanup or typing on a Samsung, and does not even send them', async () => {
      const samsung = tvOf('sam', true, {
        kind: 'samsung',
        capabilities: ['tv.remote', 'tv.kind.samsung'],
      });
      api.tvs.mockResolvedValue([samsung]);
      await started();
      await expect(store.cleanup()).resolves.toBe(false);
      expect(api.cleanup).not.toHaveBeenCalled();
      await expect(store.sendText('oi')).resolves.toMatchObject({ kind: 'forbidden' });
      expect(api.sendText).not.toHaveBeenCalled();
    });
  });
});
