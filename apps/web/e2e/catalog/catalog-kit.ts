import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Page } from '@playwright/test';
import { screenshot } from '../fixtures';
import { CATALOG_DIR, FAILURES_LOG, FRAMES_DIR, FRAMES_LOG, GAPS_LOG } from './catalog-paths';
import { settle } from '../screens/screen-helpers';

/**
 * Apoio do catálogo de telas (`npm run catalog`): cada captura vira um arquivo em `FRAMES_DIR` e uma linha em
 * `frames.jsonl`; `build-catalog.mjs` junta tudo num HTML único. Nada daqui roda na esteira normal (ver `playwright.config.ts`).
 */

export { CATALOG_DIR, FRAMES_DIR, FRAMES_LOG, FAILURES_LOG, GAPS_LOG };

export type Scheme = 'light' | 'dark';

/** O tipo do estado, para o filtro do HTML. */
export type StateKind =
  | 'padrão'
  | 'carregando'
  | 'vazio'
  | 'com dados'
  | 'erro'
  | 'sem rede'
  | 'convidado'
  | 'folha'
  | 'validação';

export interface FrameMeta {
  id: string;
  module: string;
  /** O padrão da rota como está nos arquivos de rotas (`/treino/exercicios/:id`). */
  route: string;
  /** O endereço realmente aberto. */
  url: string;
  state: string;
  kind: StateKind;
  scheme: Scheme;
  file: string;
  /** Se a captura é a página inteira, ou só o que se vê sem rolar (390 x 664). */
  full: boolean;
  /** Nota curta sobre a captura (por exemplo, "fim da rolagem"). */
  note?: string;
}

export interface Shot {
  module: string;
  route: string;
  url: string;
  state: string;
  kind: StateKind;
  scheme?: Scheme;
  note?: string;
  /** Força só o que se vê sem rolar. */
  viewportOnly?: boolean;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `f${Date.now().toString(36)}-${String(counter).padStart(4, '0')}`;
}

export function ensureDirs(): void {
  mkdirSync(FRAMES_DIR, { recursive: true });
}

function log(file: string, entry: unknown): void {
  ensureDirs();
  appendFileSync(file, JSON.stringify(entry) + '\n');
}

/** Registra o que não deu para capturar (e por quê): entra no quadro de cobertura do HTML. */
export function recordFailure(
  shot: Pick<Shot, 'module' | 'route' | 'state'>,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  log(FAILURES_LOG, { ...shot, error: message.slice(0, 240) });
}

/** Registra um estado que o simulador de testes não consegue produzir (lacuna conhecida, não falha). */
export function recordGap(module: string, route: string, state: string, reason: string): void {
  log(GAPS_LOG, { module, route, state, reason });
}

async function pageHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  );
}

/**
 * Captura a tela como está: a janela de 390 x 664 e, se a página rola, mais uma janela por vez até o fim (no máximo quatro).
 */
export async function shoot(page: Page, shot: Shot): Promise<FrameMeta[]> {
  ensureDirs();
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const scheme = shot.scheme ?? 'light';
  const viewport = page.viewportSize()?.height ?? 664;
  const height = await pageHeight(page);
  const frames: FrameMeta[] = [];

  async function take(full: boolean, note?: string): Promise<void> {
    const id = nextId();
    const file = `${id}.jpg`;
    await screenshot(page, join(FRAMES_DIR, file), { fullPage: full });
    const meta: FrameMeta = {
      id,
      module: shot.module,
      route: shot.route,
      url: shot.url,
      state: shot.state,
      kind: shot.kind,
      scheme,
      file,
      full,
      note: note ?? shot.note,
    };
    frames.push(meta);
    log(FRAMES_LOG, meta);
  }

  // Só o que se vê (390 x 664), como no aparelho: a barra do alto e a de baixo são fixas, e uma foto da página inteira as
  // deixaria no meio da tela. Página que rola sai em mais capturas, descendo uma janela por vez (no máximo quatro).
  const prefix = shot.note ? `${shot.note}; ` : '';
  if (shot.viewportOnly || height <= viewport + 24) {
    await take(false);
  } else {
    const stops = Math.min(4, Math.ceil(height / viewport));
    for (let stop = 0; stop < stops; stop++) {
      const last = stop === stops - 1;
      const y = Math.round(((height - viewport) * stop) / (stops - 1));
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await settle(page);
      const where =
        stop === 0 ? 'ao abrir' : last ? 'fim da rolagem' : `rolagem ${stop + 1} de ${stops}`;
      await take(false, `${prefix}${where}`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  return frames;
}

/**
 * Roda uma captura sem derrubar o resto: o erro vira uma linha no quadro de cobertura. O catálogo mostra o que dá para
 * mostrar; um estado que não abriu não pode apagar os demais.
 */
export async function attempt(
  shot: Pick<Shot, 'module' | 'route' | 'state'>,
  body: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await body();
    return true;
  } catch (error) {
    recordFailure(shot, error);
    return false;
  }
}

/** Troca o tema como o app o lê (`prefers-color-scheme`). Movimento reduzido: a captura nunca pega uma entrada no meio. */
export async function setScheme(
  page: Page,
  scheme: Scheme,
  reducedMotion: 'reduce' | 'no-preference' = 'reduce',
): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
}

/** Uma captura com tudo que a identifica; o preparo roda antes e qualquer erro vira falha registrada. */
export async function snap(
  page: Page,
  shot: Shot,
  prepare?: () => Promise<unknown>,
): Promise<boolean> {
  return attempt(shot, async () => {
    await setScheme(
      page,
      shot.scheme ?? 'light',
      shot.kind === 'carregando' ? 'no-preference' : 'reduce',
    );
    if (prepare) await prepare();
    await shoot(page, shot);
  });
}
