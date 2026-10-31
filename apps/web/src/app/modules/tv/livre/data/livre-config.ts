import type { AppIconSubject } from '../../ui/app-icon-source';
import type { TvShortcut } from '../../data/tv-types';
import {
  DEFAULT_LIVRE_CONFIG,
  DIM_MAX,
  LivreApp,
  LivreConfig,
  SLEEP_MAX_MINUTES,
  normalizeColor,
} from './livre-types';

/** Quantos círculos cabem na fileira da pré-visualização; na TV a fileira continua além da borda e rola. */
export const PREVIEW_MAX_TILES = 6;

/**
 * Palavras que não dizem o nome de um app dentro do nome do pacote (domínio de topo, "android", "tv"): ficam de fora do
 * nome de reserva, para `com.exemplo.cinema.tv` virar "Cinema", e não "Tv".
 */
const GENERIC_PACKAGE_WORDS = new Set([
  'com',
  'org',
  'net',
  'br',
  'io',
  'android',
  'app',
  'apps',
  'tv',
  'mobile',
  'client',
  'ninja',
]);

/**
 * O nome de um app que a TV não deu nome (nem o dono): uma palavra do pacote com a inicial maiúscula. A TV costuma
 * publicar o nome (`tvLabel`); isto é só a rede de segurança, melhor que a posição ou o pacote inteiro.
 */
export function packageLabel(packageName: string): string {
  const words = packageName.split('.').filter((word) => word !== '');
  const meaningful = words.filter((word) => !GENERIC_PACKAGE_WORDS.has(word.toLowerCase()));
  const word = meaningful.at(-1) ?? words.at(-1) ?? packageName;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Um app da lista para escolher e ordenar: o que o agente achou, mais o nome e o ícone que os atalhos da TV guardam. */
export interface LivreAppRow {
  readonly package: string;
  readonly label: string;
  readonly factory: boolean;
  readonly disabled: boolean;
  readonly chosen: boolean;
  /** O que o azulejo de ícone precisa: o ícone do atalho (ou a inicial do nome, se não houver) e o pacote. */
  readonly subject: AppIconSubject;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * Junta os apps instalados (a fonte da lista, qualquer um pode entrar na Home) com os atalhos da TV (a fonte do nome e do
 * ícone, que o agente já publicou). Sem atalho, o app ainda aparece, com o nome tirado do pacote e a inicial no lugar do ícone.
 */
export function appRows(
  apps: readonly LivreApp[],
  shortcuts: readonly TvShortcut[],
  config: LivreConfig,
): LivreAppRow[] {
  const byPackage = new Map<string, TvShortcut>();
  for (const shortcut of shortcuts) {
    if (!byPackage.has(shortcut.package)) byPackage.set(shortcut.package, shortcut);
  }
  const chosen = new Set(config.apps.items);
  return apps.map((app, index) => {
    const shortcut = byPackage.get(app.package);
    const label =
      shortcut?.customLabel?.trim() || shortcut?.tvLabel?.trim() || packageLabel(app.package);
    return {
      package: app.package,
      label,
      factory: app.factory,
      disabled: app.disabled,
      chosen: chosen.has(app.package),
      subject: {
        package: app.package,
        position: index + 1,
        customLabel: null,
        tvLabel: label,
        iconDataUri: shortcut?.iconDataUri ?? null,
      },
    };
  });
}

/** A lista de apps dividida como a tela a mostra: os escolhidos na ordem da Home, os outros e os de fábrica, por nome. */
export interface LivreAppGroups {
  readonly chosen: readonly LivreAppRow[];
  readonly others: readonly LivreAppRow[];
  readonly factory: readonly LivreAppRow[];
}

export function groupApps(rows: readonly LivreAppRow[], config: LivreConfig): LivreAppGroups {
  const byPackage = new Map(rows.map((row) => [row.package, row]));
  const chosen = config.apps.items.flatMap((name) => {
    const row = byPackage.get(name);
    return row ? [row] : [];
  });
  const rest = rows
    .filter((row) => !row.chosen)
    .sort((first, second) => collator.compare(first.label, second.label));
  return {
    chosen,
    others: rest.filter((row) => !row.factory),
    factory: rest.filter((row) => row.factory),
  };
}

/**
 * Põe a regra da lista de apps de acordo com a escolha: com algum app escolhido a Home mostra só eles (`listed`, na
 * ordem); sem nenhum, a Home mostra tudo o que não é de fábrica (`all`). Os de fábrica nunca aparecem sozinhos: só se a
 * pessoa os escolhe (citados em `items` eles aparecem mesmo assim), por isso `showFactory` fica desligado.
 */
export function normalizeApps(config: LivreConfig): LivreConfig {
  const items = [...new Set(config.apps.items)];
  return {
    ...config,
    apps: {
      mode: items.length > 0 ? 'listed' : 'all',
      items,
      hidden: config.apps.hidden.filter((name) => !items.includes(name)),
      showFactory: false,
    },
  };
}

/** Liga ou desliga um app da Home; um app ligado entra no fim da ordem. */
export function setAppChosen(config: LivreConfig, name: string, chosen: boolean): LivreConfig {
  const has = config.apps.items.includes(name);
  if (chosen === has) return config;
  const items = chosen
    ? [...config.apps.items, name]
    : config.apps.items.filter((item) => item !== name);
  return normalizeApps({ ...config, apps: { ...config.apps, items } });
}

/** Sobe (`-1`) ou desce (`1`) um app escolhido na ordem da Home; sem para onde ir, devolve a mesma configuração. */
export function moveApp(config: LivreConfig, name: string, delta: -1 | 1): LivreConfig {
  const from = config.apps.items.indexOf(name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= config.apps.items.length) return config;
  const items = [...config.apps.items];
  [items[from], items[to]] = [items[to], items[from]];
  return { ...config, apps: { ...config.apps, items } };
}

/** O que a Home mostrará na TV, na ordem em que o launcher a monta (o contrato diz como: `listed` ou `all`). */
export function previewApps(config: LivreConfig, rows: readonly LivreAppRow[]): LivreAppRow[] {
  const shown = (row: LivreAppRow | undefined): row is LivreAppRow =>
    row !== undefined && !row.disabled && !config.apps.hidden.includes(row.package);
  const byPackage = new Map(rows.map((row) => [row.package, row]));
  const first = config.apps.items.map((name) => byPackage.get(name)).filter(shown);
  if (config.apps.mode === 'listed') return first;
  const taken = new Set(first.map((row) => row.package));
  const rest = rows
    .filter(
      (row) => shown(row) && !taken.has(row.package) && (config.apps.showFactory || !row.factory),
    )
    .sort((a, b) => collator.compare(a.label, b.label));
  return [...first, ...rest];
}

function clampDim(dim: number): number {
  const value = Number.isFinite(dim) ? dim : DEFAULT_LIVRE_CONFIG.wallpaper.dim;
  return Math.round(Math.min(DIM_MAX, Math.max(0, value)) * 100) / 100;
}

/**
 * A configuração que vai à API a partir do que a pessoa montou na tela. Parte do rascunho (então o que a tela não edita,
 * como o tamanho do relógio, segue como estava) e acerta só o que a API recusaria: apps que não estão mais na TV, a foto
 * escolhida sem haver foto (volta ao degradê, como o launcher faria), cores fora de `#rrggbb`, tempo e escurecimento
 * fora dos limites. Com a lista de apps vazia (o agente ainda não mandou o estado) os escolhidos ficam como estão.
 */
export function buildConfig(
  draft: LivreConfig,
  context: { readonly hasPhoto: boolean; readonly apps: readonly LivreApp[] },
): LivreConfig {
  const installed = new Set(context.apps.map((app) => app.package));
  const items = draft.apps.items.filter((name) => installed.size === 0 || installed.has(name));
  const defaults = DEFAULT_LIVRE_CONFIG.wallpaper.colors;
  const colors = draft.wallpaper.colors.map(normalizeColor).filter((c): c is string => c !== null);
  const first = colors[0] ?? defaults[0];
  const type =
    draft.wallpaper.type === 'photo' && !context.hasPhoto ? 'gradient' : draft.wallpaper.type;
  return normalizeApps({
    ...draft,
    wallpaper: {
      ...draft.wallpaper,
      type,
      colors: [first, colors[1] ?? (colors.length > 0 ? first : defaults[1])],
      dim: clampDim(draft.wallpaper.dim),
    },
    apps: { ...draft.apps, items },
    sleep: {
      maxMinutes: Math.min(SLEEP_MAX_MINUTES, Math.max(0, Math.round(draft.sleep.maxMinutes) || 0)),
    },
  });
}

/** As duas configurações dizem o mesmo (a ordem dos apps conta; a das chaves não). */
export function sameConfig(first: LivreConfig, second: LivreConfig): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Direções do Android (anti-horário a partir da direita) nas palavras do CSS: de canto a canto, qualquer que seja a proporção. */
const CSS_DIRECTIONS: Readonly<Record<number, string>> = {
  0: 'to right',
  45: 'to top right',
  90: 'to top',
  135: 'to top left',
  180: 'to left',
  225: 'to bottom left',
  270: 'to bottom',
  315: 'to bottom right',
};

/** O fundo em degradê do contrato como `linear-gradient` (o ângulo fora dos oito válidos cai no padrão, 315). */
export function gradientCss(colors: readonly string[], angle: number): string {
  const direction = CSS_DIRECTIONS[angle] ?? CSS_DIRECTIONS[315];
  const [first, second = first] =
    colors.length > 0 ? colors : DEFAULT_LIVRE_CONFIG.wallpaper.colors;
  return `linear-gradient(${direction}, ${first}, ${second})`;
}

/** Combinações prontas de duas cores, todas escuras: o relógio e os nomes dos apps são brancos sobre o fundo. */
export interface GradientPreset {
  readonly id: string;
  readonly label: string;
  readonly colors: readonly [string, string];
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  {
    id: 'dusk',
    label: $localize`:@@tv-livre.preset.dusk:Anoitecer`,
    colors: ['#1b2440', '#3a2d5c'],
  },
  {
    id: 'ocean',
    label: $localize`:@@tv-livre.preset.ocean:Oceano`,
    colors: ['#0f2b46', '#1f6f8b'],
  },
  {
    id: 'forest',
    label: $localize`:@@tv-livre.preset.forest:Floresta`,
    colors: ['#10261b', '#2f6b4b'],
  },
  { id: 'ember', label: $localize`:@@tv-livre.preset.ember:Brasa`, colors: ['#2b1219', '#7a2e3a'] },
  {
    id: 'graphite',
    label: $localize`:@@tv-livre.preset.graphite:Grafite`,
    colors: ['#16181d', '#3a404c'],
  },
  {
    id: 'night',
    label: $localize`:@@tv-livre.preset.night:Madrugada`,
    colors: ['#0b1020', '#273c75'],
  },
];

/** A combinação pronta que tem exatamente estas duas cores, se houver (marca o botão escolhido). */
export function presetFor(colors: readonly string[]): GradientPreset | null {
  const [first, second] = colors.map((color) => color.toLowerCase());
  return (
    GRADIENT_PRESETS.find((preset) => preset.colors[0] === first && preset.colors[1] === second) ??
    null
  );
}

/** A hora e a data que o relógio da pré-visualização mostra, como o launcher as mostraria. */
export function previewClock(
  now: Date,
  clock: LivreConfig['clock'],
): { readonly time: string; readonly date: string } {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    ...(clock.seconds ? { second: '2-digit' } : {}),
    // "auto" segue o sistema da TV, que a web não sabe: vale o padrão brasileiro, de 24 horas.
    hourCycle: clock.format === '12h' ? 'h12' : 'h23',
  };
  return {
    time: new Intl.DateTimeFormat('pt-BR', options).format(now),
    date: new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(now),
  };
}
