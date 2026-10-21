import { type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Routes } from '@angular/router';
import { catalog, setupScreen } from '../shell/screen-test-kit';
import { CHART_ENGINE } from './charts/chart-engine';
import { FakeChartEngine } from './charts/chart-test-kit';
import { ProgressHistory } from './history';

/**
 * Peças de teste da tela de Progresso: o ambiente das telas do Treino (banco em memória, fila falsa, relógio em
 * 1.760.000.000.000 ms) com o catálogo de teste gravado, o motor de gráfico falso no lugar da biblioteca e o histórico
 * da tela. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */
export async function setupProgress(
  routes: Routes = [{ path: '**', children: [] }],
  extra: Provider[] = [],
  engine = new FakeChartEngine(),
) {
  const kit = await setupScreen(routes, [
    { provide: CHART_ENGINE, useValue: engine },
    ProgressHistory,
    ...extra,
  ]);
  await kit.trainingDb.exercises.bulkPut(catalog());
  return { ...kit, engine, history: () => TestBed.inject(ProgressHistory) };
}

/**
 * Seis semanas de supino, um treino por semana (os dias contam de `HISTORY_START`, e o "agora" dos testes cai no dia 115;
 * a janela de 8 semanas cobre os dias 59 a 115). A conta é feita à mão: Epley, carga × (1 + repetições / 30).
 *
 *   dia 64 (18/08)  32,5 × 10 → 43,33     dia 85 (08/09)  40   ×  8 → 50,67
 *   dia 71 (25/08)  35   × 10 → 46,67     dia 92 (15/09)  40   × 10 → 53,33
 *   dia 78 (01/09)  37,5 × 10 → 50,00     dia 99 (22/09)  42,5 ×  8 → 53,83
 */
export const BENCH_HISTORY = [
  [64, 32.5, 10],
  [71, 35, 10],
  [78, 37.5, 10],
  [85, 40, 8],
  [92, 40, 10],
  [99, 42.5, 8],
] as const;
