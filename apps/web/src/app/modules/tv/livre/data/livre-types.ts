import { TV_LIVRE_CAPABILITY } from '../../../../core/modules/tv-livre-entry.port';
import type { TvSummary } from '../../data/tv-types';

export { TV_LIVRE_CAPABILITY };

/**
 * Tipos escritos à mão das rotas `/v1/tv/livre`: o contrato gerado do OpenAPI ainda não as traz, e a leitura abaixo é
 * tolerante de propósito (um campo que falta ou vem torto volta ao padrão, nunca derruba a tela).
 */

export type LivreClockSize = 'large' | 'medium' | 'small';
export type LivreClockFormat = '24h' | '12h' | 'auto';
export type LivreWallpaperType = 'gradient' | 'solid' | 'photo';
export type LivreAppsMode = 'listed' | 'all';
export type LivreIconSize = 'small' | 'medium' | 'large';
export type LivreLabels = 'always' | 'focus' | 'never';

/** A configuração que a API guarda e o agente aplica (o contrato do launcher, sem `schema`, `revision` e `photo`). */
export interface LivreConfig {
  readonly clock: {
    readonly enabled: boolean;
    readonly size: LivreClockSize;
    readonly format: LivreClockFormat;
    readonly seconds: boolean;
    readonly date: boolean;
  };
  readonly wallpaper: {
    readonly type: LivreWallpaperType;
    readonly colors: readonly string[];
    readonly angle: number;
    readonly dim: number;
  };
  readonly apps: {
    readonly mode: LivreAppsMode;
    readonly items: readonly string[];
    readonly hidden: readonly string[];
    readonly showFactory: boolean;
  };
  readonly icons: { readonly size: LivreIconSize; readonly labels: LivreLabels };
  readonly builtin: { readonly settings: boolean; readonly sleep: boolean };
  readonly sleep: { readonly maxMinutes: number };
}

/** Um app que o agente achou instalado na TV; `factory` é de sistema nunca atualizado, `disabled` foi desativado pelo agente. */
export interface LivreApp {
  readonly package: string;
  readonly factory: boolean;
  readonly disabled: boolean;
}

/** O estado do TV Livre na TV atual, como `GET /v1/tv/livre` devolve. */
export interface TvLivreView {
  /** O agente da TV está ligado e declara a capacidade `tv.livre.v1`. */
  readonly available: boolean;
  /** Do último estado que o agente mandou (`null`: nunca chegou um). */
  readonly supported: boolean | null;
  readonly installed: boolean;
  readonly version: string | null;
  /** O TV Livre é a tela inicial da TV agora. */
  readonly isHome: boolean;
  readonly factoryLauncher: string | null;
  readonly disabledPackages: readonly string[];
  readonly apps: readonly LivreApp[];
  readonly stateAt: string | null;
  readonly config: LivreConfig;
  readonly hasPhoto: boolean;
  /** A última revisão aplicada (0 = nunca aplicada). */
  readonly revision: number;
}

/** O padrão da Home aprovada: relógio grande, degradê azul-arroxeado e os apps de fábrica ocultos (todo o resto à vista). */
export const DEFAULT_LIVRE_CONFIG: LivreConfig = {
  clock: { enabled: true, size: 'large', format: '24h', seconds: false, date: true },
  wallpaper: { type: 'gradient', colors: ['#1b2440', '#3a2d5c'], angle: 315, dim: 0.25 },
  apps: { mode: 'all', items: [], hidden: [], showFactory: false },
  icons: { size: 'medium', labels: 'always' },
  builtin: { settings: true, sleep: false },
  sleep: { maxMinutes: 0 },
};

/** Maior tempo no Modo Dormir que o contrato aceita (12 horas). */
export const SLEEP_MAX_MINUTES = 720;
/** Escurecimento máximo da foto que o contrato aceita. */
export const DIM_MAX = 0.8;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A cor `#rrggbb` em minúsculas (o que `<input type="color">` entrega), ou `null` se o texto não for uma. */
export function normalizeColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Lê a configuração do servidor; o que faltar ou vier torto vale o padrão. */
export function parseLivreConfig(value: unknown): LivreConfig {
  const dto = record(value);
  const d = DEFAULT_LIVRE_CONFIG;
  const clock = record(dto['clock']);
  const wallpaper = record(dto['wallpaper']);
  const apps = record(dto['apps']);
  const icons = record(dto['icons']);
  const builtin = record(dto['builtin']);
  const sleep = record(dto['sleep']);

  const colors = (Array.isArray(wallpaper['colors']) ? wallpaper['colors'] : [])
    .map(normalizeColor)
    .filter((color): color is string => color !== null);
  const dim = typeof wallpaper['dim'] === 'number' ? wallpaper['dim'] : d.wallpaper.dim;
  const angle = typeof wallpaper['angle'] === 'number' ? wallpaper['angle'] : d.wallpaper.angle;
  const maxMinutes =
    typeof sleep['maxMinutes'] === 'number' ? sleep['maxMinutes'] : d.sleep.maxMinutes;

  return {
    clock: {
      enabled: flag(clock['enabled'], d.clock.enabled),
      size: pick(clock['size'], ['large', 'medium', 'small'], d.clock.size),
      format: pick(clock['format'], ['24h', '12h', 'auto'], d.clock.format),
      seconds: flag(clock['seconds'], d.clock.seconds),
      date: flag(clock['date'], d.clock.date),
    },
    wallpaper: {
      type: pick(wallpaper['type'], ['gradient', 'solid', 'photo'], d.wallpaper.type),
      colors: colors.length > 0 ? colors : d.wallpaper.colors,
      angle: Number.isFinite(angle) ? angle : d.wallpaper.angle,
      dim: Number.isFinite(dim) ? Math.min(DIM_MAX, Math.max(0, dim)) : d.wallpaper.dim,
    },
    apps: {
      mode: pick(apps['mode'], ['listed', 'all'], d.apps.mode),
      items: texts(apps['items']),
      hidden: texts(apps['hidden']),
      showFactory: flag(apps['showFactory'], d.apps.showFactory),
    },
    icons: {
      size: pick(icons['size'], ['small', 'medium', 'large'], d.icons.size),
      labels: pick(icons['labels'], ['always', 'focus', 'never'], d.icons.labels),
    },
    builtin: {
      settings: flag(builtin['settings'], d.builtin.settings),
      sleep: flag(builtin['sleep'], d.builtin.sleep),
    },
    sleep: {
      maxMinutes: Number.isFinite(maxMinutes)
        ? Math.min(SLEEP_MAX_MINUTES, Math.max(0, Math.round(maxMinutes)))
        : d.sleep.maxMinutes,
    },
  };
}

function parseApp(value: unknown): LivreApp | null {
  const dto = record(value);
  const name = dto['package'];
  if (typeof name !== 'string' || name === '') return null;
  return { package: name, factory: dto['factory'] === true, disabled: dto['disabled'] === true };
}

/** Lê a resposta de `GET /livre` (e das rotas que a devolvem); `null` quando não tem a forma esperada. */
export function parseLivreView(value: unknown): TvLivreView | null {
  if (!value || typeof value !== 'object') return null;
  const dto = value as Record<string, unknown>;
  if (typeof dto['available'] !== 'boolean') return null;
  const seen = new Set<string>();
  const apps = (Array.isArray(dto['apps']) ? dto['apps'] : [])
    .map(parseApp)
    .filter((app): app is LivreApp => {
      if (app === null || seen.has(app.package)) return false;
      seen.add(app.package);
      return true;
    });
  return {
    available: dto['available'],
    supported: typeof dto['supported'] === 'boolean' ? dto['supported'] : null,
    installed: dto['installed'] === true,
    version: typeof dto['version'] === 'string' && dto['version'] !== '' ? dto['version'] : null,
    isHome: dto['isHome'] === true,
    factoryLauncher:
      typeof dto['factoryLauncher'] === 'string' && dto['factoryLauncher'] !== ''
        ? dto['factoryLauncher']
        : null,
    disabledPackages: texts(dto['disabledPackages']),
    apps,
    stateAt: typeof dto['stateAt'] === 'string' ? dto['stateAt'] : null,
    config: parseLivreConfig(dto['config']),
    hasPhoto: dto['hasPhoto'] === true,
    revision:
      typeof dto['revision'] === 'number' && Number.isFinite(dto['revision'])
        ? Math.max(0, Math.trunc(dto['revision']))
        : 0,
  };
}

/** A TV declara o TV Livre? Aqui a falta de informação vale "não": não se oferece a instalação no escuro. */
export function tvHasLivre(tv: TvSummary | null): boolean {
  return tv?.capabilities.includes(TV_LIVRE_CAPABILITY) === true;
}
