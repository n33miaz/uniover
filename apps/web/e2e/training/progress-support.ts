import { BrowserContext, Page } from '@playwright/test';
import { expect } from '../fixtures';
import { PROGRESS_EXERCISE_IDS, PROGRESS_NOW, seedProgress } from './progress-seed';
import { openTraining, startTraining } from './support/training-pages';
import { TrainingServer } from './support/training-server';

/**
 * Apoio dos testes da tela de Progresso: relógio fixo em quarta-feira, 21/10/2026, ao meio-dia (o histórico semeado em
 * `progress-seed` conta a partir dele), entrada como dono, o histórico no servidor de teste e a tela aberta. O relógio
 * segue andando a partir daquela hora (a fila de envio e os temporizadores do app dependem disso).
 */

/** O endereço da tela já no supino (o exercício do histórico mais completo). */
export const BENCH_URL = `/treino/progresso?exercise=${PROGRESS_EXERCISE_IDS.bench}`;

export async function startProgress(
  context: BrowserContext,
  page: Page,
  options: { history?: boolean; more?: boolean } = {},
): Promise<TrainingServer> {
  await page.clock.install({ time: PROGRESS_NOW });
  const server = await startTraining(context, page);
  if (options.history !== false) seedProgress(server, { more: options.more });
  return server;
}

/** Abre a tela e espera o gráfico (ou o estado que o substitui) aparecer. */
export async function openProgress(page: Page, path = BENCH_URL): Promise<void> {
  await openTraining(page, path);
  await expect(page.getByRole('heading', { name: 'Evolução' })).toBeVisible();
}

/** O gráfico de linha, pelo resumo falado dele. */
export const chart = (page: Page) => page.getByRole('img', { name: /^Gráfico de linha/ });

/** Abre a tabela dos mesmos dados e devolve as linhas (dia, valor, apoio), da mais nova para a mais antiga. */
export async function tableRows(page: Page): Promise<string[][]> {
  // O botão só existe depois de o gráfico carregar: o clique espera por ele; com a tabela já aberta, não toca de novo.
  if (!(await page.getByRole('button', { name: 'Ocultar Dados' }).isVisible())) {
    await page.getByRole('button', { name: 'Ver Dados' }).click();
  }
  await expect(page.locator('app-progress-evolution table')).toBeVisible();
  return page
    .locator('app-progress-evolution tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => Array.from(row.children).map((cell) => (cell.textContent ?? '').trim())),
    );
}

/** Espera o desenho do gráfico: a linha e os pontos têm a cor de destaque do tema, e o canvas não tem DOM. */
export async function expectChartDrawn(page: Page): Promise<void> {
  await expect
    .poll(async () => (await chartPixels(page, ['--a-accent']))['--a-accent'], { timeout: 15_000 })
    .toBeGreaterThan(150);
}

/**
 * Quantos pixels do desenho têm (quase) a cor de cada token do tema. O canvas não tem DOM, então a prova de que a linha, os
 * pontos e a meta foram mesmo desenhados é achar a cor deles nos pixels. As cores vêm do tema da página (claro ou escuro).
 */
export async function chartPixels(
  page: Page,
  tokens: readonly string[],
): Promise<Record<string, number>> {
  return page.evaluate((names) => {
    const canvas = document.querySelector<HTMLCanvasElement>('app-progress-line-chart canvas');
    if (!canvas) return Object.fromEntries(names.map((name) => [name, -1]));
    const context = canvas.getContext('2d')!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const probe = document.createElement('canvas').getContext('2d')!;
    const rgb = (token: string): [number, number, number] => {
      probe.fillStyle = '#000';
      probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const wanted = names.map((name) => ({ name, color: rgb(name) }));
    const counts: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 200) continue;
      for (const { name, color } of wanted) {
        const distance =
          Math.abs(data[index] - color[0]) +
          Math.abs(data[index + 1] - color[1]) +
          Math.abs(data[index + 2] - color[2]);
        if (distance < 24) counts[name]++;
      }
    }
    return counts;
  }, tokens);
}
