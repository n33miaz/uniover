import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../../core/session/session-state';
import { TvApi } from '../../data/tv-api';
import { makeShortcut } from '../../tv-test-kit';
import { TvLivreApi } from './livre-api';
import { TvLivreStore } from './livre-store';
import { LIVRE_PHOTO_REDUCER, PhotoFit } from './photo-fit';
import { DEFAULT_LIVRE_CONFIG, TvLivreView } from './livre-types';

const APPS = [
  { package: 'com.exemplo.alfa', factory: false, disabled: false },
  { package: 'com.exemplo.beta', factory: false, disabled: false },
  { package: 'com.exemplo.fabrica', factory: true, disabled: false },
];

function view(overrides: Partial<TvLivreView> = {}): TvLivreView {
  return {
    available: true,
    supported: true,
    installed: true,
    version: '1.0.0',
    isHome: false,
    factoryLauncher: null,
    disabledPackages: [],
    apps: APPS,
    stateAt: '2026-10-31T12:00:00Z',
    config: DEFAULT_LIVRE_CONFIG,
    hasPhoto: false,
    revision: 0,
    ...overrides,
  };
}

function failure(status: number, extra: Record<string, unknown> = {}) {
  return new HttpErrorResponse({
    status,
    error: { type: 'https://uniover.app/problems/command-failed', status, ...extra },
  });
}

/** Deixa as promessas pendentes (e o efeito do store) andarem. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('TvLivreStore', () => {
  const calls: string[] = [];
  const api = {
    get: vi.fn(),
    refresh: vi.fn(),
    saveConfig: vi.fn(),
    apply: vi.fn(),
    install: vi.fn(),
    setHome: vi.fn(),
    restore: vi.fn(),
    sleep: vi.fn(),
    putPhoto: vi.fn(),
    photo: vi.fn(),
    deletePhoto: vi.fn(),
  };
  const tvApi = { shortcuts: vi.fn() };
  const reducer = vi.fn<(file: Blob) => Promise<PhotoFit<Blob>>>();
  let store: TvLivreStore;

  beforeEach(() => {
    calls.length = 0;
    for (const fn of [...Object.values(api), tvApi.shortcuts, reducer]) fn.mockReset();
    api.get.mockResolvedValue(view());
    api.photo.mockResolvedValue(null);
    tvApi.shortcuts.mockResolvedValue([
      makeShortcut(1, { package: 'com.exemplo.alfa', tvLabel: 'Alfa' }),
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: TvLivreApi, useValue: api },
        { provide: TvApi, useValue: tvApi },
        { provide: LIVRE_PHOTO_REDUCER, useValue: reducer },
      ],
    });
    TestBed.inject(SessionState).setUser({
      id: 'conta-dono',
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
    store = TestBed.inject(TvLivreStore);
  });

  afterEach(() => localStorage.clear());

  async function open() {
    store.start();
    await settle();
  }

  describe('opening', () => {
    it('shows the wait only until the first state arrives, then builds the draft from it', async () => {
      store.start();
      expect(store.loading()).toBe(true);
      expect(store.view()).toBeNull();
      await settle();
      expect(store.loading()).toBe(false);
      expect(store.view()?.version).toBe('1.0.0');
      expect(store.draft()?.apps.mode).toBe('all');
      expect(store.dirty()).toBe(false);
    });

    it('takes name and icon of the apps from the shortcuts of the TV', async () => {
      await open();
      const names = store.groups().others.map((row) => row.label);
      expect(names).toEqual(['Alfa', 'Beta']);
      expect(store.groups().factory.map((row) => row.package)).toEqual(['com.exemplo.fabrica']);
    });

    it('still lists the apps when the shortcuts cannot be read', async () => {
      tvApi.shortcuts.mockRejectedValue(new Error('sem atalhos'));
      await open();
      expect(store.groups().others).toHaveLength(2);
      expect(store.loadFailure()).toBeNull();
    });

    it('gives a short sentence when the first reading fails, and recovers on retry', async () => {
      api.get.mockRejectedValueOnce(
        failure(503, { type: 'https://uniover.app/problems/agent-offline' }),
      );
      await open();
      expect(store.view()).toBeNull();
      expect(store.loadFailure()).toContain('agente da TV');
      await store.load();
      expect(store.loadFailure()).toBeNull();
      expect(store.view()).not.toBeNull();
    });

    it('keeps the screen on a failed refresh once there is a state, as a notice', async () => {
      await open();
      api.get.mockRejectedValueOnce(failure(504));
      await store.load();
      expect(store.view()).not.toBeNull();
      expect(store.loadFailure()).toBeNull();
      expect(store.notice()?.kind).toBe('error');
    });

    it('does not read anything after stop until it is started again', async () => {
      await open();
      store.stop();
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('what the screen may do', () => {
    it('can use the TV only with the agent at hand and a compatible TV', async () => {
      api.get.mockResolvedValue(view({ available: true, supported: null }));
      await open();
      expect(store.canUse()).toBe(true);
      expect(store.block()).toBeNull();

      api.get.mockResolvedValue(view({ available: false, supported: true }));
      await store.load();
      expect(store.canUse()).toBe(false);
      expect(store.block()).toBe('offline');
      expect(store.restoreVisible()).toBe(true);

      api.get.mockResolvedValue(view({ available: true, supported: false }));
      await store.load();
      expect(store.block()).toBe('unsupported');
      expect(store.restoreVisible()).toBe(false);
    });
  });

  describe('choosing and ordering apps', () => {
    it('chosen apps become "listed" in order, none means "all" with the factory hidden', async () => {
      await open();
      store.setAppChosen('com.exemplo.beta', true);
      store.setAppChosen('com.exemplo.alfa', true);
      expect(store.draft()?.apps).toMatchObject({
        mode: 'listed',
        items: ['com.exemplo.beta', 'com.exemplo.alfa'],
        showFactory: false,
      });
      expect(store.preview().map((row) => row.label)).toEqual(['Beta', 'Alfa']);
      store.moveApp('com.exemplo.alfa', -1);
      expect(store.draft()?.apps.items).toEqual(['com.exemplo.alfa', 'com.exemplo.beta']);
      store.setAppChosen('com.exemplo.alfa', false);
      store.setAppChosen('com.exemplo.beta', false);
      expect(store.draft()?.apps.mode).toBe('all');
      expect(store.preview().map((row) => row.label)).toEqual(['Alfa', 'Beta']);
    });

    it('knows when there is something not sent to the TV yet', async () => {
      await open();
      expect(store.dirty()).toBe(false);
      store.setAppChosen('com.exemplo.alfa', true);
      expect(store.dirty()).toBe(true);
      store.setAppChosen('com.exemplo.alfa', false);
      expect(store.dirty()).toBe(false);
    });
  });

  describe('apply', () => {
    it('saves the config and only then applies it, adopting what the server answers', async () => {
      await open();
      store.setAppChosen('com.exemplo.beta', true);
      store.setColors('#0f2b46', '#1f6f8b');
      api.saveConfig.mockImplementation(async () => {
        calls.push('save');
        return view({ config: { ...DEFAULT_LIVRE_CONFIG } });
      });
      api.apply.mockImplementation(async () => {
        calls.push('apply');
        return view({ revision: 5 });
      });
      expect(await store.apply()).toBe(true);
      expect(calls).toEqual(['save', 'apply']);
      const sent = api.saveConfig.mock.calls[0][0];
      expect(sent.apps).toEqual({
        mode: 'listed',
        items: ['com.exemplo.beta'],
        hidden: [],
        showFactory: false,
      });
      expect(sent.wallpaper.colors).toEqual(['#0f2b46', '#1f6f8b']);
      expect(store.view()?.revision).toBe(5);
      expect(store.notice()).toEqual({ kind: 'ok', text: 'Aplicado na TV.' });
      expect(store.busy()).toBeNull();
    });

    it('does not apply when saving fails, and says why in a short sentence', async () => {
      await open();
      api.saveConfig.mockRejectedValue(failure(400));
      expect(await store.apply()).toBe(false);
      expect(api.apply).not.toHaveBeenCalled();
      expect(store.notice()?.kind).toBe('error');
      expect(store.busy()).toBeNull();
    });

    it('tells that it was saved when only applying fails, with the code of the agent translated', async () => {
      await open();
      api.saveConfig.mockResolvedValue(view());
      api.apply.mockRejectedValue(failure(502, { agentError: 'push_failed' }));
      expect(await store.apply()).toBe(false);
      expect(store.notice()).toEqual({
        kind: 'error',
        text: 'Salvo, mas a TV não aplicou. Não deu para enviar os arquivos à TV.',
      });
    });

    it('does one request at a time: a second one while the first runs is ignored', async () => {
      await open();
      let release!: () => void;
      api.saveConfig.mockReturnValue(
        new Promise<TvLivreView>((resolve) => (release = () => resolve(view()))),
      );
      api.apply.mockResolvedValue(view());
      const first = store.apply();
      expect(store.busy()).toBe('apply');
      expect(await store.sleep()).toBe(false);
      expect(api.sleep).not.toHaveBeenCalled();
      release();
      expect(await first).toBe(true);
      expect(store.busy()).toBeNull();
    });
  });

  describe('install, home, restore, sleep and refresh', () => {
    it('installs and adopts the new state', async () => {
      await open();
      api.install.mockResolvedValue(view({ installed: true, version: '1.1.0' }));
      expect(await store.install()).toBe(true);
      expect(store.view()?.version).toBe('1.1.0');
      expect(store.notice()?.text).toBe('TV Livre instalado.');
    });

    it('sets as home with the choice about the factory launcher', async () => {
      await open();
      api.setHome.mockResolvedValue(view({ isHome: true }));
      await store.setHome(true);
      expect(api.setHome).toHaveBeenCalledWith(true);
      expect(store.view()?.isHome).toBe(true);
    });

    it('goes back to the original, and a failure of the agent is translated', async () => {
      await open();
      api.restore.mockResolvedValue(view({ installed: false }));
      expect(await store.restore()).toBe(true);
      expect(api.restore).toHaveBeenCalledWith(true);
      expect(store.view()?.installed).toBe(false);

      api.restore.mockRejectedValue(failure(502, { agentError: 'uninstall_failed' }));
      expect(await store.restore()).toBe(false);
      expect(store.notice()?.text).toBe('Não deu para desinstalar o TV Livre.');
    });

    it('sends the sleep command and says so', async () => {
      await open();
      api.sleep.mockResolvedValue(undefined);
      expect(await store.sleep()).toBe(true);
      expect(store.notice()?.text).toContain('Modo Dormir');
    });

    it('asks the agent for the state of now', async () => {
      await open();
      api.refresh.mockResolvedValue(view({ isHome: true }));
      await store.refresh();
      expect(store.view()?.isHome).toBe(true);
    });

    it('keeps the draft when a new state arrives from an action', async () => {
      await open();
      store.setAppChosen('com.exemplo.alfa', true);
      api.refresh.mockResolvedValue(view());
      await store.refresh();
      expect(store.draft()?.apps.items).toEqual(['com.exemplo.alfa']);
    });
  });

  describe('photo', () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

    it('reduces, sends, and makes the photo the background', async () => {
      await open();
      reducer.mockResolvedValue({
        status: 'ok',
        blob: jpeg,
        size: { width: 10, height: 10 },
        quality: 0.85,
      });
      api.putPhoto.mockResolvedValue(undefined);
      expect(await store.choosePhoto(new Blob(['png']))).toBe(true);
      expect(api.putPhoto).toHaveBeenCalledWith(jpeg);
      expect(store.view()?.hasPhoto).toBe(true);
      expect(store.draft()?.wallpaper.type).toBe('photo');
      expect(store.photoUrl()).toMatch(/^data:image\/jpeg;base64,/);
    });

    it.each([
      ['invalid', 'Não deu para ler esta foto.'],
      ['too-big', 'A foto continua grande demais mesmo reduzida.'],
    ] as const)('sends nothing when the photo is %s', async (status, text) => {
      await open();
      reducer.mockResolvedValue({ status });
      expect(await store.choosePhoto(new Blob(['x']))).toBe(false);
      expect(api.putPhoto).not.toHaveBeenCalled();
      expect(store.notice()).toEqual({ kind: 'error', text });
      expect(store.view()?.hasPhoto).toBe(false);
    });

    it('translates what the server says when sending the photo fails', async () => {
      await open();
      reducer.mockResolvedValue({
        status: 'ok',
        blob: jpeg,
        size: { width: 1, height: 1 },
        quality: 0.5,
      });
      api.putPhoto.mockRejectedValue(failure(413));
      expect(await store.choosePhoto(new Blob(['x']))).toBe(false);
      expect(store.notice()?.text).toContain('grande demais');
      expect(store.draft()?.wallpaper.type).toBe('gradient');
    });

    it('goes back to the gradient when the photo is removed while it is the background', async () => {
      api.get.mockResolvedValue(
        view({
          hasPhoto: true,
          config: {
            ...DEFAULT_LIVRE_CONFIG,
            wallpaper: { ...DEFAULT_LIVRE_CONFIG.wallpaper, type: 'photo' },
          },
        }),
      );
      api.photo.mockResolvedValue(jpeg);
      await open();
      await settle();
      expect(store.photoUrl()).toMatch(/^data:image\/jpeg/);
      api.deletePhoto.mockResolvedValue(undefined);
      expect(await store.removePhoto()).toBe(true);
      expect(store.view()?.hasPhoto).toBe(false);
      expect(store.photoUrl()).toBeNull();
      expect(store.draft()?.wallpaper.type).toBe('gradient');
    });

    it('works without the thumbnail when reading the photo fails', async () => {
      api.get.mockResolvedValue(view({ hasPhoto: true }));
      api.photo.mockRejectedValue(new Error('x'));
      await open();
      await settle();
      expect(store.view()?.hasPhoto).toBe(true);
      expect(store.photoUrl()).toBeNull();
    });
  });

  describe('editing', () => {
    it('ignores a color that is not #rrggbb', async () => {
      await open();
      store.setColor(0, 'vermelho');
      expect(store.draft()?.wallpaper.colors[0]).toBe('#1b2440');
      store.setColor(1, '#AABBCC');
      expect(store.draft()?.wallpaper.colors).toEqual(['#1b2440', '#aabbcc']);
    });

    it('keeps the sleep time between 0 and 720 minutes', async () => {
      await open();
      store.setSleepMax(30);
      expect(store.draft()?.sleep.maxMinutes).toBe(30);
      store.setSleepMax(5000);
      expect(store.draft()?.sleep.maxMinutes).toBe(720);
      store.setSleepMax(-4);
      expect(store.draft()?.sleep.maxMinutes).toBe(0);
      store.setSleepMax(Number.NaN);
      expect(store.draft()?.sleep.maxMinutes).toBe(0);
    });

    it('clears the notice of the last request as soon as the person edits again', async () => {
      await open();
      api.sleep.mockResolvedValue(undefined);
      await store.sleep();
      expect(store.notice()).not.toBeNull();
      store.setDim(0.4);
      expect(store.notice()).toBeNull();
    });
  });

  describe('another account', () => {
    it('forgets everything and reads again for the one who is using the screen', async () => {
      await open();
      store.setAppChosen('com.exemplo.alfa', true);
      expect(store.view()).not.toBeNull();
      api.get.mockResolvedValue(view({ version: '9.9.9' }));
      TestBed.inject(SessionState).setUser({
        id: 'outra-conta',
        email: 'outra@exemplo.com',
        displayName: 'Outra',
        role: 'owner',
      });
      await settle();
      await settle();
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(store.view()?.version).toBe('9.9.9');
      expect(store.draft()?.apps.items).toEqual([]);
    });

    it('throws away an answer that arrives after the change', async () => {
      let late!: (value: TvLivreView) => void;
      api.get.mockReturnValueOnce(new Promise<TvLivreView>((resolve) => (late = resolve)));
      TestBed.tick();
      store.start();
      TestBed.inject(SessionState).setUser({
        id: 'outra-conta',
        email: 'outra@exemplo.com',
        displayName: 'Outra',
        role: 'owner',
      });
      await settle();
      late(view({ version: 'velha' }));
      await settle();
      expect(store.view()?.version).not.toBe('velha');
    });
  });
});
