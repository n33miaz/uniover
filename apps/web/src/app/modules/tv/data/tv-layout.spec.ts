import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvApi } from './tv-api';
import {
  TV_PREFS_DEFAULTS,
  TvLayoutValue,
  TvPrefs,
  tvLayoutCacheKey,
  tvPrefsStorageKey,
} from './tv-prefs';
import { TvSelection } from './tv-selection';

const CASA = {
  id: 'casa',
  name: 'Casa',
  isDefault: true,
  agentSlug: null,
  kind: 'android' as const,
  online: true,
  capabilities: ['tv.key.INPUT'],
};
const RAPHAEL = { ...CASA, id: 'raphael', name: 'Raphael', isDefault: false };
const base = (name: string): TvLayoutValue => ({
  name,
  buttonSize: 'large',
  showMedia: false,
  showChannel: true,
  startPage: 'numbers',
  padSpeed: 'fast',
  pillLayout: 'row',
  extraKeys: ['INPUT'],
  dismissedSuggestions: [],
});

describe('base comum do controle', () => {
  let layouts: Map<string, TvLayoutValue>;
  let api: Pick<TvApi, 'layout' | 'seedLayout' | 'saveLayout'>;
  let prefs: TvPrefs;
  let selection: TvSelection;

  const settle = async () => {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    localStorage.clear();
    layouts = new Map();
    api = {
      layout: vi.fn(async (id: string) => layouts.get(id) ?? null),
      seedLayout: vi.fn(async (id: string, value: TvLayoutValue) => {
        if (layouts.has(id)) throw new Error('A base já existe.');
        layouts.set(id, value);
        return value;
      }),
      saveLayout: vi.fn(async (id: string, value: TvLayoutValue) => {
        layouts.set(id, value);
        return value;
      }),
    };
    TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
    TestBed.inject(SessionState).setUser({
      id: 'owner',
      email: 'owner@example.com',
      displayName: 'Dono',
      role: 'owner',
    });
    selection = TestBed.inject(TvSelection);
    prefs = TestBed.inject(TvPrefs);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('semeia uma única vez as escolhas locais do dono e compartilha a base', async () => {
    localStorage.setItem(
      tvPrefsStorageKey('owner'),
      JSON.stringify({ name: 'Sala', buttonSize: 'large', vibration: false }),
    );
    // A preferência já estava guardada antes de o serviço nascer.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
    TestBed.inject(SessionState).setUser({
      id: 'owner',
      email: 'owner@example.com',
      displayName: 'Dono',
      role: 'owner',
    });
    selection = TestBed.inject(TvSelection);
    prefs = TestBed.inject(TvPrefs);
    selection.setTvs([CASA]);
    await settle();
    expect(api.seedLayout).toHaveBeenCalledTimes(1);
    expect(layouts.get('casa')?.name).toBe('Sala');
    expect(layouts.get('casa')).not.toHaveProperty('vibration');
    expect(prefs.vibration()).toBe(false);
    await settle();
    expect(api.seedLayout).toHaveBeenCalledTimes(1);
  });

  it('dono grava na base e convidado altera só o próprio ajuste', async () => {
    layouts.set('casa', base('Sala'));
    selection.setTvs([CASA]);
    await settle();
    prefs.set({ buttonSize: 'compact' });
    await settle();
    expect(layouts.get('casa')?.buttonSize).toBe('compact');
    const saves = vi.mocked(api.saveLayout).mock.calls.length;
    prefs.set({ vibration: false });
    await settle();
    expect(vi.mocked(api.saveLayout).mock.calls).toHaveLength(saves);
    expect(layouts.get('casa')).not.toHaveProperty('vibration');

    TestBed.inject(SessionState).setUser({
      id: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'guest',
    });
    // Trocar de conta zera a lista de TVs; o app a pede de novo para a conta nova.
    selection.setTvs([CASA]);
    await settle();
    expect(prefs.name()).toBe('Sala');
    expect(prefs.buttonSize()).toBe('compact');
    prefs.set({ name: 'Meu nome' });
    await settle();
    expect(prefs.name()).toBe('Meu nome');
    expect(layouts.get('casa')?.name).toBe('Sala');
    expect(JSON.parse(localStorage.getItem(tvPrefsStorageKey('alice')) ?? '{}')).toEqual({
      name: 'Meu nome',
    });
  });

  it('voltar ao padrão limpa o ajuste da convidada e revela a base atual', async () => {
    layouts.set('casa', base('Sala'));
    TestBed.inject(SessionState).setUser({
      id: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'guest',
    });
    selection.setTvs([CASA]);
    await settle();
    prefs.set({ name: 'Pessoal', vibration: false });
    expect(prefs.customized()).toBe(true);
    prefs.reset();
    expect(prefs.name()).toBe('Sala');
    expect(prefs.vibration()).toBe(TV_PREFS_DEFAULTS.vibration);
    expect(prefs.customized()).toBe(false);
    expect(localStorage.getItem(tvPrefsStorageKey('alice'))).toBeNull();
  });

  it('troca de TV lê outra base e outra cópia local sem misturar os ajustes', async () => {
    layouts.set('casa', base('Sala'));
    layouts.set('raphael', base('Raphael'));
    TestBed.inject(SessionState).setUser({
      id: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'guest',
    });
    selection.setTvs([CASA, RAPHAEL]);
    await settle();
    prefs.set({ name: 'Minha sala' });
    selection.select('raphael');
    await settle();
    expect(prefs.name()).toBe('Raphael');
    prefs.set({ buttonSize: 'compact' });
    selection.select('casa');
    await settle();
    expect(prefs.name()).toBe('Minha sala');
    expect(prefs.buttonSize()).toBe('large');
    expect(JSON.parse(localStorage.getItem(tvLayoutCacheKey('raphael')) ?? '{}').name).toBe(
      'Raphael',
    );
  });

  it('abre a última base conhecida sem rede e sem a lista de TVs', async () => {
    layouts.set('casa', base('Sala offline'));
    selection.setTvs([CASA]);
    await settle();
    expect(prefs.name()).toBe('Sala offline');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: TvApi,
          useValue: {
            ...api,
            layout: vi.fn(async () => {
              throw new Error('offline');
            }),
          },
        },
      ],
    });
    TestBed.inject(SessionState).setUser({
      id: 'owner',
      email: 'owner@example.com',
      displayName: 'Dono',
      role: 'owner',
    });
    const offlinePrefs = TestBed.inject(TvPrefs);
    expect(offlinePrefs.name()).toBe('Sala offline');
  });

  it('envia uma mudança do dono feita sem rede na próxima leitura', async () => {
    layouts.set('casa', base('Sala'));
    selection.setTvs([CASA]);
    await settle();
    api.saveLayout = vi.fn(async () => {
      throw new Error('offline');
    });
    prefs.set({ name: 'Sala nova' });
    await settle();
    expect(layouts.get('casa')?.name).toBe('Sala');
    expect(prefs.name()).toBe('Sala nova');

    api.saveLayout = vi.fn(async (id: string, value: TvLayoutValue) => {
      layouts.set(id, value);
      return value;
    });
    selection.setTvs([{ ...CASA }]);
    await vi.waitFor(() => expect(layouts.get('casa')?.name).toBe('Sala nova'));
    expect(prefs.name()).toBe('Sala nova');
  });
});
