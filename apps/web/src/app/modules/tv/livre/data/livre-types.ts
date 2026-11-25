import type { TvSummary } from '../../data/tv-types';

export const TV_LIVRE_CAPABILITY = 'tv.livre.v1';

/** O agente sabe dormir sem instalar o launcher: é o que libera o Modo Dormir para quem não é o dono. */
export const TV_LIVRE_SLEEP_NO_INSTALL_CAPABILITY = 'tv.livre.sleep-no-install.v1';

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
  readonly builtin: {
    readonly settings: boolean;
    readonly sleep: boolean;
    /** Rede, Entradas e o nome do sistema na tela inicial da TV (launcher de nível 2: um anterior os ignora). */
    readonly network: boolean;
    readonly inputs: boolean;
    readonly brand: boolean;
  };
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
  /** O agente declara os acréscimos do segundo passo do módulo (`tv.livre.v2`); falso: age como antes. */
  readonly extended: boolean;
  /** O nível do launcher que o agente leu na TV; `null` quando não leu (sem o app, ou agente anterior). */
  readonly launcherLevel: number | null;
  /** O último apply só gravou a configuração porque outro app estava na frente. */
  readonly applyDeferred: boolean;
  /**
   * Aviso do agente sobre o pedido que acabou de dar certo (por exemplo, o pacote da TV TCL restaurado). Só as respostas das
   * ações o trazem; a leitura do estado vem sempre sem ele.
   */
  readonly notice: string | null;
}

/**
 * O nível do launcher que esta versão do app espera: o que a publicação atual instala. Não é a versão (essa muda a cada
 * publicação e faria o aviso de atualização disparar sempre): só cresce quando o launcher ganha algo que a tela usa.
 * 2: Modo Dormir com volume e mídia e com o tempo no pedido; Rede, Entradas e o nome na tela inicial; ícones aparados.
 */
export const LAUNCHER_LEVEL_LATEST = 2;

/** O padrão da Home aprovada: relógio grande, degradê azul-arroxeado e os apps de fábrica ocultos (todo o resto à vista). */
export const DEFAULT_LIVRE_CONFIG: LivreConfig = {
  clock: { enabled: true, size: 'large', format: '24h', seconds: false, date: true },
  wallpaper: { type: 'gradient', colors: ['#1b2440', '#3a2d5c'], angle: 315, dim: 0.25 },
  apps: { mode: 'all', items: [], hidden: [], showFactory: false },
  icons: { size: 'medium', labels: 'always' },
  builtin: { settings: true, sleep: true, network: true, inputs: true, brand: true },
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
      network: flag(builtin['network'], d.builtin.network),
      inputs: flag(builtin['inputs'], d.builtin.inputs),
      brand: flag(builtin['brand'], d.builtin.brand),
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
    extended: dto['extended'] === true,
    launcherLevel:
      typeof dto['launcherLevel'] === 'number' && Number.isInteger(dto['launcherLevel'])
        ? dto['launcherLevel']
        : null,
    applyDeferred: dto['applyDeferred'] === true,
    notice:
      typeof dto['notice'] === 'string' && dto['notice'].trim() !== '' ? dto['notice'].trim() : null,
  };
}

/** A TV declara o TV Livre? Aqui a falta de informação vale "não": não se oferece a instalação no escuro. */
export function tvHasLivre(tv: TvSummary | null): boolean {
  return tv?.capabilities.includes(TV_LIVRE_CAPABILITY) === true;
}

/**
 * O agente desta TV, online e com o TV Livre, é anterior ao dormir sem instalação? Só é verdadeiro quando se sabe: com o
 * agente fora ou sem a lista de capacidades vale "não", e o pedido segue para a API, que responde o motivo.
 */
export function tvNeedsSleepAgentUpdate(tv: TvSummary | null): boolean {
  return (
    tv?.online === true &&
    tv.capabilities.includes(TV_LIVRE_CAPABILITY) &&
    !tv.capabilities.includes(TV_LIVRE_SLEEP_NO_INSTALL_CAPABILITY)
  );
}
