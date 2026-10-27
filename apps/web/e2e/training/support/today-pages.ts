import { Page } from '@playwright/test';
import { expect } from '../../fixtures';
import { countRows, openTraining } from './training-pages';

/**
 * Passos comuns dos testes da aba Hoje e do treino ao vivo. O relógio da página é o do Playwright (`page.clock`),
 * instalado no horário real e correndo normalmente: o teste só o empurra para a frente quando precisa de tempo passando.
 */

/** Instala o relógio controlado no horário de agora. Chamar antes de qualquer navegação. */
export async function installClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date() });
}

/**
 * Abre a aba Hoje e espera a rotina do dia aparecer. Com `history` (o padrão), espera também o histórico do supino chegar
 * do servidor: quem começa o treino antes disso vê o cartão sem a última vez (o que o app corrige sozinho, mas o teste
 * quer medir o caso normal).
 */
export async function openToday(
  page: Page,
  options: { path?: string; history?: boolean } = {},
): Promise<void> {
  await openTraining(page, options.path ?? '/treino');
  await expect(page.getByRole('heading', { name: 'Semana', exact: true })).toBeVisible();
  if (options.history !== false) {
    await expect(page.locator('.lines .ui-row').first()).toContainText('última vez 40 kg × 10');
  }
}

/**
 * Sem programa semanal, iniciar abre antes a escolha do programa; a maioria dos testes quer só treinar, então segue
 * sem programa. Com programa ativo (ou treino já aberto) a folha não aparece e nada acontece.
 */
export async function skipProgramChoice(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Seguir sem programa' });
  const live = page.locator('app-live-session');
  await expect(skip.or(live)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
}

/** Toca em "Iniciar treino" e espera a tela do treino ao vivo. */
export async function beginWorkout(page: Page, title = /Treino A/): Promise<void> {
  await page.getByRole('button', { name: 'Iniciar treino' }).click();
  await skipProgramChoice(page);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir série' })).toBeEnabled();
}

/** Toca `times` vezes no botão de − ou + de um campo (pelo nome acessível). */
export async function tap(page: Page, name: string, times = 1): Promise<void> {
  for (let index = 0; index < times; index++) {
    await page.getByRole('button', { name, exact: true }).click();
  }
}

/** O valor que o campo (carga ou repetições) mostra agora. */
export function fieldValue(page: Page, group: 'Carga' | 'Repetições') {
  return page.getByRole('group', { name: new RegExp(`^${group}`) }).getByRole('textbox');
}

/**
 * Conclui a série atual e espera ela ficar gravada no aparelho. Antes, o relógio anda um segundo: um segundo toque em menos
 * de 600 ms é tido como acidente (e o teste não é um dedo nervoso).
 */
export async function concludeSet(page: Page): Promise<void> {
  const before = await countRows(page, 'sets');
  await page.clock.fastForward(1000);
  await page.getByRole('button', { name: 'Concluir série' }).click();
  await expect.poll(() => countRows(page, 'sets')).toBe(before + 1);
}

/** Abre o menu do treino ("Opções do treino") e toca numa linha dele. */
export async function menu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Opções do treino' }).click();
  const dialog = page.getByRole('dialog', { name: 'Opções do treino' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: item }).click();
}

/** Aparelhos falsos: vibração, áudio e tela acesa, contados pela própria página (sem depender do navegador do teste). */
export interface DeviceStubs {
  /** `true` põe uma `navigator.vibrate` que anota as chamadas; `false` a remove (como o iPhone). */
  readonly vibrate?: boolean;
  /** `true` põe uma `navigator.wakeLock` falsa, que anota os pedidos; `'none'` a remove (navegador sem a API). */
  readonly wakeLock?: boolean | 'none';
}

export async function stubDevice(page: Page, stubs: DeviceStubs): Promise<void> {
  await page.addInitScript((options) => {
    const win = window as unknown as Record<string, unknown>;
    win['__vibrations'] = [] as unknown[];
    win['__audioContexts'] = 0;
    // Qualquer tentativa de criar áudio fica registrada: o aviso do descanso só vibra.
    const Counting = function () {
      (win['__audioContexts'] as number)++;
    };
    win['AudioContext'] = Counting;
    win['webkitAudioContext'] = Counting;

    if (options.vibrate !== undefined) {
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: options.vibrate
          ? (pattern: unknown) => {
              (win['__vibrations'] as unknown[]).push(pattern);
              return true;
            }
          : undefined,
      });
    }

    if (options.wakeLock === 'none') {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    } else if (options.wakeLock) {
      const state = { requests: 0, active: 0, sentinels: [] as { release(): Promise<void> }[] };
      win['__wake'] = state;
      let visibility = 'visible';
      win['__setVisibility'] = (next: string) => {
        visibility = next;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async () => {
            state.requests++;
            state.active++;
            let listener: (() => void) | null = null;
            const sentinel = {
              released: false,
              release: async () => {
                if (sentinel.released) return;
                sentinel.released = true;
                state.active--;
                listener?.();
              },
              addEventListener: (_type: string, fn: () => void) => {
                listener = fn;
              },
            };
            state.sentinels.push(sentinel);
            return sentinel;
          },
        },
      });
    }
  }, stubs);
}

/** O que a página anotou dos aparelhos falsos. */
export async function deviceLog(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    const wake = win['__wake'] as { requests: number; active: number } | undefined;
    return {
      vibrations: (win['__vibrations'] as unknown[]) ?? [],
      audioContexts: (win['__audioContexts'] as number) ?? 0,
      wakeRequests: wake?.requests ?? 0,
      wakeActive: wake?.active ?? 0,
    };
  });
}
