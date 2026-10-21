import { InjectionToken } from '@angular/core';
import type { ChartEngine } from './chart-types';
import { uplotEngine } from './uplot-engine';

/**
 * A biblioteca de gráficos por trás de uma porta. O padrão é o uPlot (que só baixa quando há o que desenhar); o teste de
 * unidade troca por uma falsa, porque o jsdom não tem canvas.
 */
export const CHART_ENGINE = new InjectionToken<ChartEngine>('training progress chart engine', {
  providedIn: 'root',
  factory: () => uplotEngine,
});
