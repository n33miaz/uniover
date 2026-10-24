import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvApi, tvEventsPath } from './tv-api';
import { TvSelection } from './tv-selection';
import type { TvShortcut } from './tv-types';

const SHORTCUT = {
  id: 'a1',
  position: 1,
  package: 'p',
  tvLabel: null,
  customLabel: null,
  enabled: true,
  installed: true,
};

describe('TvApi', () => {
  let api: TvApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(TvApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for the cleanup with a POST without body and returns what the agent reported', async () => {
    const result = api.cleanup();
    const request = http.expectOne('/api/v1/tv/cleanup');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    const report = {
      ok: true,
      latencyMs: 8000,
      closedApps: 6,
      freedMb: 382,
      memoryBeforeMb: 214,
      memoryAfterMb: 596,
      failedSteps: ['force-stop:com.exemplo.player'],
    };
    request.flush(report);
    expect(await result).toEqual(report);
  });

  it('reads and normalizes the state', async () => {
    const state = api.state();
    const request = http.expectOne('/api/v1/tv/state');
    expect(request.request.method).toBe('GET');
    request.flush({
      power: 'on',
      volume: '15',
      app: null,
      connection: 'hibernating',
      agentOnline: true,
      updatedAt: null,
    });
    expect(await state).toMatchObject({ volume: 15, connection: 'hibernating' });
  });

  it('rejects a state in an unexpected shape', async () => {
    const state = api.state();
    http.expectOne('/api/v1/tv/state').flush('lixo');
    await expect(state).rejects.toThrow();
  });

  it('lists the shortcuts in position order', async () => {
    const list = api.shortcuts();
    http.expectOne('/api/v1/tv/shortcuts').flush([
      { ...SHORTCUT, id: 'b', position: 2 },
      { ...SHORTCUT, id: 'a', position: 1 },
    ]);
    expect((await list).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('wakes with a POST and no body', async () => {
    const done = api.wake();
    const request = http.expectOne('/api/v1/tv/wake');
    expect(request.request.method).toBe('POST');
    request.flush(null, { status: 202, statusText: 'Accepted' });
    await done;
  });

  it('sends a key as JSON', async () => {
    const done = api.sendKey('VOLUME_UP');
    const request = http.expectOne('/api/v1/tv/keys');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ key: 'VOLUME_UP', direction: null });
    request.flush({ ok: true, latencyMs: 30 });
    await done;
  });

  it('powers off with a single POST to its own route', async () => {
    const done = api.powerOff();
    const request = http.expectOne('/api/v1/tv/power/off');
    expect(request.request.method).toBe('POST');
    request.flush({ ok: true, latencyMs: 30 });
    await done;
  });

  it('sends the text, launches a shortcut and refreshes the list', async () => {
    const text = api.sendText('batman');
    const sent = http.expectOne('/api/v1/tv/text');
    expect(sent.request.body).toEqual({ text: 'batman' });
    sent.flush({ ok: true, latencyMs: 1 });
    await text;

    const launch = api.launch('a b');
    http.expectOne('/api/v1/tv/shortcuts/a%20b/launch').flush({ ok: true, latencyMs: 1 });
    await launch;

    const refresh = api.refreshShortcuts();
    http.expectOne('/api/v1/tv/shortcuts/refresh').flush({ ok: true, latencyMs: 1 });
    await refresh;
  });

  it('edits a shortcut sending only what changes', async () => {
    const rename = api.updateShortcut('a1', { customLabel: 'Sala' });
    const patch = http.expectOne('/api/v1/tv/shortcuts/a1');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ customLabel: 'Sala', enabled: null });
    patch.flush({ ...SHORTCUT, customLabel: 'Sala' });
    expect((await rename).customLabel).toBe('Sala');

    const hide = api.updateShortcut('a1', { enabled: false });
    const second = http.expectOne('/api/v1/tv/shortcuts/a1');
    expect(second.request.body).toEqual({ customLabel: null, enabled: false });
    second.flush({ ...SHORTCUT, enabled: false });
    const hidden = await hide;
    // Tirar do controle não desinstala o app: ele continua podendo ser aberto.
    expect(hidden.enabled).toBe(false);
    expect(hidden.installed).toBe(true);
  });

  it('reads the answer of an edit without "installed" (an older server) as installed when it is active', async () => {
    const legacy: Partial<TvShortcut> = { ...SHORTCUT };
    delete legacy.installed;
    const pin = api.updateShortcut('a1', { enabled: true });
    http.expectOne('/api/v1/tv/shortcuts/a1').flush({ ...legacy, enabled: true });
    expect((await pin).installed).toBe(true);
  });

  describe('with several TVs', () => {
    const tv = (id: string, isDefault: boolean) => ({
      id,
      name: id,
      isDefault,
      agentSlug: null,
      kind: 'android' as const,
      online: true,
      capabilities: [],
    });
    const choose = (id: string) => {
      TestBed.inject(SessionState).setUser({ id: 'c', email: 'c@x.y', displayName: 'C' });
      const selection = TestBed.inject(TvSelection);
      selection.setTvs([tv('casa', true), tv('amigo', false)]);
      selection.select(id);
    };

    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('asks the state, the shortcuts and the commands of the chosen TV', async () => {
      choose('amigo');
      const state = api.state();
      http.expectOne('/api/v1/tv/state?tvId=amigo').flush({ agentOnline: true });
      await state;
      const shortcuts = api.shortcuts();
      http.expectOne('/api/v1/tv/shortcuts?tvId=amigo').flush([]);
      await shortcuts;

      const key = api.sendKey('HOME');
      const sent = http.expectOne('/api/v1/tv/keys?tvId=amigo');
      expect(sent.request.body).toEqual({ key: 'HOME', direction: null });
      sent.flush({});
      await key;

      const off = api.powerOff();
      http.expectOne('/api/v1/tv/power/off?tvId=amigo').flush({});
      await off;
      const wake = api.wake();
      http
        .expectOne('/api/v1/tv/wake?tvId=amigo')
        .flush(null, { status: 202, statusText: 'Accepted' });
      await wake;
      const clean = api.cleanup();
      http.expectOne('/api/v1/tv/cleanup?tvId=amigo').flush({});
      await clean;
      const launch = api.launch('a1');
      http.expectOne('/api/v1/tv/shortcuts/a1/launch?tvId=amigo').flush({});
      await launch;
      const refresh = api.refreshShortcuts();
      http.expectOne('/api/v1/tv/shortcuts/refresh?tvId=amigo').flush({});
      await refresh;
      const order = api.reorderShortcuts(['a1']);
      http.expectOne('/api/v1/tv/shortcuts/order?tvId=amigo').flush([SHORTCUT]);
      await order;
      const text = api.sendText('oi');
      http.expectOne('/api/v1/tv/text?tvId=amigo').flush({});
      await text;
      const rename = api.updateShortcut('a1', { enabled: false });
      http.expectOne('/api/v1/tv/shortcuts/a1?tvId=amigo').flush(SHORTCUT);
      await rename;
    });

    it('reads the TV id at the moment of the call: a request already sent stays with its TV', async () => {
      choose('amigo');
      const first = api.state();
      const request = http.expectOne('/api/v1/tv/state?tvId=amigo');
      TestBed.inject(TvSelection).select('casa');
      request.flush({ agentOnline: true });
      await first;
      const second = api.state();
      http.expectOne('/api/v1/tv/state?tvId=casa').flush({ agentOnline: true });
      await second;
    });

    it('leaves the list of TVs without a tv id (it is where the id comes from)', async () => {
      choose('amigo');
      const list = api.tvs();
      const request = http.expectOne('/api/v1/tv/tvs');
      expect(request.request.method).toBe('GET');
      request.flush({ items: [tv('casa', true)] });
      expect((await list).map((item) => item.id)).toEqual(['casa']);
    });

    it('refuses a list in an unexpected format', async () => {
      const list = api.tvs();
      http.expectOne('/api/v1/tv/tvs').flush({ itens: [] });
      await expect(list).rejects.toThrow();
    });
  });

  it('sends nothing extra with a single TV or no list at all', async () => {
    const state = api.state();
    http.expectOne('/api/v1/tv/state').flush({ agentOnline: true });
    await state;
    const key = api.sendKey('HOME');
    http.expectOne('/api/v1/tv/keys').flush({});
    await key;
  });

  it('builds the events path with the TV id only when there is one', () => {
    expect(tvEventsPath(null)).toBe('/api/v1/tv/events');
    expect(tvEventsPath('a b')).toBe('/api/v1/tv/events?tvId=a%20b');
  });
});
