import { Page } from '@playwright/test';
import { expect } from '../fixtures';
import { PROGRESS_EXERCISE_IDS } from './progress-seed';
import { expectChartDrawn, openProgress } from './progress-support';
import { SEED_EXERCISE_IDS } from './support/training-seed';

/**
 * Os estados da tela de Progresso que as medidas de acessibilidade e as capturas percorrem: cada um diz como abrir a tela
 * até o estado (e com que dados semeados). Não é um teste: quem roda é `progress-a11y.spec` e `progress-shots.spec`.
 */
export interface State {
  readonly name: string;
  readonly options?: { history?: boolean; more?: boolean };
  readonly open: (page: Page) => Promise<void>;
}

/** O botão que abre uma seção (o título e o resumo dela). Não confunde com as setas "Semana anterior" de dentro. */
export const section = (page: Page, title: RegExp) =>
  page.locator('button.toggle', { hasText: title });

export const STATES: readonly State[] = [
  {
    name: 'gráfico de 1RM com o resumo das seções fechadas',
    open: async (page) => {
      await openProgress(page);
      await expectChartDrawn(page);
    },
  },
  {
    name: 'tabela de dados aberta',
    open: async (page) => {
      await openProgress(page);
      await page.getByRole('button', { name: 'Ver dados' }).click();
      await expect(page.locator('app-progress-evolution table')).toBeVisible();
    },
  },
  {
    name: 'carga máxima',
    open: async (page) => {
      await openProgress(page);
      await page.getByRole('button', { name: 'Carga máxima', exact: true }).click();
      await expect(page.locator('app-progress-evolution .value')).toHaveText('45 kg');
    },
  },
  {
    name: 'meta de 1RM no gráfico',
    open: async (page) => {
      await openProgress(page);
      await page.getByRole('button', { name: 'Definir meta' }).click();
      const sheet = page.getByRole('dialog', { name: /^Meta de 1RM/ });
      await sheet.getByLabel('Meta de 1RM, em kg').fill('55');
      await sheet.getByRole('button', { name: 'Salvar' }).click();
      await expect(page.getByRole('button', { name: /^Meta: 55 kg/ })).toBeVisible();
      await expect(sheet).toHaveCount(0);
    },
  },
  {
    name: 'folha da meta, com erro',
    open: async (page) => {
      await openProgress(page);
      await page.getByRole('button', { name: 'Definir meta' }).click();
      const sheet = page.getByRole('dialog', { name: /^Meta de 1RM/ });
      await sheet.getByLabel('Meta de 1RM, em kg').fill('0');
      await sheet.getByRole('button', { name: 'Salvar' }).click();
      await expect(sheet.getByRole('alert')).toBeVisible();
    },
  },
  {
    name: 'recordes abertos',
    open: async (page) => {
      await openProgress(page);
      await section(page, /^Recordes/).click();
      await expect(page.locator('app-progress-records .row')).toHaveCount(4);
    },
  },
  {
    name: 'semana aberta',
    open: async (page) => {
      await openProgress(page);
      await section(page, /^Semana/).click();
      await expect(page.locator('app-progress-week .bar')).toHaveCount(6);
    },
  },
  {
    name: 'frequência aberta',
    open: async (page) => {
      await openProgress(page);
      await section(page, /^Frequência/).click();
      await expect(page.locator('app-progress-frequency .day.on')).toHaveCount(5);
    },
  },
  {
    name: 'exportar aberto, com a mensagem de uma ação',
    open: async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async () => undefined },
        });
      });
      await openProgress(page);
      await section(page, /^Exportar e compartilhar/).click();
      await page.getByRole('button', { name: /^Compartilhar resumo da semana/ }).click();
      await expect(
        page.locator('app-progress-export .status', { hasText: 'copiado' }),
      ).toBeVisible();
    },
  },
  {
    name: 'exercício sem registro',
    open: async (page) => {
      await openProgress(page, `/treino/progresso?exercise=${SEED_EXERCISE_IDS.plank}`);
      await expect(page.getByText('Sem registro deste exercício ainda.')).toBeVisible();
    },
  },
  {
    name: 'um treino só',
    open: async (page) => {
      await openProgress(page, `/treino/progresso?exercise=${PROGRESS_EXERCISE_IDS.squat}`);
      await expect(page.locator('app-progress-evolution .hint')).toBeVisible();
      await expectChartDrawn(page);
    },
  },
  {
    name: 'sem nenhum treino',
    options: { history: false },
    open: async (page) => {
      await page.goto('/treino/progresso');
      await expect(
        page.getByRole('heading', { name: 'Registre um treino para ver o progresso' }),
      ).toBeVisible();
    },
  },
  {
    name: 'folha Outro exercício',
    options: { more: true },
    open: async (page) => {
      await openProgress(page, '/treino/progresso');
      await page.getByRole('button', { name: 'Outro exercício', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Outro exercício' })).toBeVisible();
    },
  },
];
