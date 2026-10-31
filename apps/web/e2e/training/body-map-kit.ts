import { Page } from '@playwright/test';
import { expect } from '../fixtures';
import { SEED_EXERCISE_IDS } from './support/training-seed';
import { TrainingServer, dotnetInstant } from './support/training-server';
import { openTraining } from './support/training-pages';

/**
 * Peças dos testes do mapa do corpo. O servidor de teste e os dados-semente são os genéricos do Treino
 * (`support/**`, sem edição); aqui só entra o que é do mapa: treinos desta semana, para dar volume ao desenho, e atalhos
 * para tocar nas zonas e abrir a tela.
 */

const SESSION_ID = '30000000-0000-4000-8000-000000000001';

/**
 * Põe no servidor um treino desta semana com séries de trabalho por exercício (`[exercício, quantas séries]`). Os instantes
 * são os de agora, para a série cair sempre na semana de hoje (domingo a sábado). Chamar depois de `startTraining` e antes de
 * abrir a tela: o mapa lê o que o aparelho puxou.
 */
export function seedWeek(
  server: TrainingServer,
  work: readonly (readonly [exerciseId: string, count: number])[],
): void {
  const now = Date.now();
  server.seed('sessions', [
    {
      id: SESSION_ID,
      routineId: null,
      startedAt: dotnetInstant(now - 120_000),
      finishedAt: dotnetInstant(now - 30_000),
      note: null,
      feeling: null,
      deviceId: 'aparelho-de-teste',
      clientUpdatedAt: dotnetInstant(now - 120_000),
      deleted: false,
    },
  ]);
  let index = 0;
  const rows = work.flatMap(([exerciseId, count]) =>
    Array.from({ length: count }, () => {
      index++;
      return {
        id: `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        sessionId: SESSION_ID,
        exerciseId,
        position: index,
        setType: 'work',
        weightKg: 40,
        reps: 10,
        durationS: null,
        rir: null,
        rpe: null,
        note: null,
        completedAt: dotnetInstant(now - 60_000 + index * 100),
        clientUpdatedAt: dotnetInstant(now - 60_000),
        deleted: false,
      };
    }),
  );
  server.seed('sets', rows);
}

/** Uma semana de exemplo: peito forte, costas e pernas no meio, bíceps leve; tríceps e abdômen sem série. */
export function seedExampleWeek(server: TrainingServer): void {
  seedWeek(server, [
    [SEED_EXERCISE_IDS.bench, 8],
    [SEED_EXERCISE_IDS.pushUp, 4],
    [SEED_EXERCISE_IDS.wger, 5],
    [SEED_EXERCISE_IDS.row, 6],
    [SEED_EXERCISE_IDS.squat, 3],
    [SEED_EXERCISE_IDS.curl, 2],
  ]);
}

/** Abre o mapa pelo endereço e espera a figura (o catálogo já lido do banco local). */
export async function openMap(page: Page, query = ''): Promise<void> {
  await openTraining(page, `/treino/exercicios/mapa${query}`);
  await expect(page.locator('.figure')).toBeVisible();
}

export const zone = (page: Page, muscle: string) =>
  page.locator(`.figure .zone[data-muscle="${muscle}"]`);

/** Toca no meio da primeira área de toque da zona (o centro da zona inteira pode cair entre os dois lados do corpo). */
export const tapZone = (page: Page, muscle: string) =>
  zone(page, muscle).locator('.tile').first().click();

export const panel = (page: Page) => page.locator('app-body-panel');

export const listChip = (page: Page, muscle: string) =>
  page.locator(`app-muscle-list .chip[data-muscle="${muscle}"]`);

/** Vira a figura e espera o giro de 240 ms terminar: medir ou tocar durante a animação pega a figura de lado. */
export async function showFace(page: Page, face: 'Frente' | 'Costas'): Promise<void> {
  await page.getByRole('button', { name: face, exact: true }).click();
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/** Os exercícios do painel, na ordem. */
export const panelRows = (page: Page) => page.locator('app-body-panel .row-name');

export interface TileBox {
  readonly muscle: string;
  readonly width: number;
  readonly height: number;
}

/** O tamanho, em pixels da tela, de cada área de toque de cada zona da face à mostra. */
export async function tileBoxes(page: Page): Promise<TileBox[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<SVGGElement>('.figure .zone')).flatMap((zone) =>
      Array.from(zone.querySelectorAll('.tile')).map((tile) => {
        const box = tile.getBoundingClientRect();
        return { muscle: zone.dataset['muscle'] ?? '', width: box.width, height: box.height };
      }),
    ),
  );
}

/**
 * Para cada zona da face à mostra, em que zona cai um toque no centro e nos quatro cantos (um pixel para dentro) de cada área
 * de toque, e no centro de cada forma desenhada. Tudo deve cair na própria zona: é o teste de que nenhuma área disputa o toque
 * com a vizinha.
 */
export async function touchOwners(page: Page): Promise<{ muscle: string; hits: string[] }[]> {
  return page.evaluate(() => {
    const owner = (x: number, y: number): string => {
      const found = document.elementFromPoint(x, y)?.closest<SVGGElement>('.zone');
      return found?.dataset['muscle'] ?? '(nenhuma)';
    };
    return Array.from(document.querySelectorAll<SVGGElement>('.figure .zone')).map((zone) => {
      const hits: string[] = [];
      for (const tile of Array.from(zone.querySelectorAll('.tile'))) {
        const b = tile.getBoundingClientRect();
        const points: [number, number][] = [
          [b.left + b.width / 2, b.top + b.height / 2],
          [b.left + 1, b.top + 1],
          [b.right - 1, b.top + 1],
          [b.left + 1, b.bottom - 1],
          [b.right - 1, b.bottom - 1],
        ];
        for (const [x, y] of points) hits.push(owner(x, y));
      }
      for (const shape of Array.from(zone.querySelectorAll('.shape'))) {
        const b = shape.getBoundingClientRect();
        hits.push(owner(b.left + b.width / 2, b.top + b.height / 2));
      }
      return { muscle: zone.dataset['muscle'] ?? '', hits };
    });
  });
}
