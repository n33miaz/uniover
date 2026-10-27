import { InjectionToken } from '@angular/core';
import type UPlot from 'uplot';
import { CHART_ENGINE } from '../../progress/charts/chart-engine';
import { nearestIndex } from '../../progress/charts/chart-model';
import { readChartColors, watchTheme } from '../../progress/charts/chart-theme';
import {
  CHART_HEIGHT,
  type ChartEngine,
  type ChartHandle,
  type ChartSpec,
} from '../../progress/charts/chart-types';
import type { WeightChartSpec } from './weight-model';

const hasTrend = (spec: ChartSpec): spec is WeightChartSpec => 'trendYs' in spec;

/** Dados no formato da biblioteca: o eixo do tempo, a tendência (linha) e as pesagens (pontos). */
function dataOf(spec: ChartSpec): UPlot.AlignedData {
  const trend = hasTrend(spec) ? spec.trendYs : spec.ys;
  return [[...spec.xs], [...trend], [...spec.ys]];
}

/**
 * Motor do gráfico de peso: a mesma biblioteca (uPlot, carregada sob demanda) e as mesmas cores do tema do gráfico de
 * Progresso, com duas séries: a LINHA é a tendência, e os PONTOS são as pesagens (anel vazio, sem linha). A distinção não
 * depende só de cor: a linha é cheia e grossa, os pontos são anéis finos.
 *
 * O desenho vive aqui, e não no componente do gráfico de Progresso, para esse componente continuar como está: o da tela de
 * Progresso desenha uma série só.
 */
export const weightChartEngine: ChartEngine = {
  async create(host, initial, width, events): Promise<ChartHandle> {
    const { default: Chart } = await import('uplot');
    const doc = host.ownerDocument;
    let spec = initial;
    let colors = readChartColors(host);

    const font = (size: number) => `400 ${size}px ${colors.font}`;

    // Por cima do desenho: o ponto em destaque (a pesagem que o texto acima do gráfico descreve).
    const drawOverlay = (plot: UPlot) => {
      const selected = spec.selected;
      if (selected === null || selected >= spec.xs.length) return;
      const ctx = plot.ctx;
      const ratio = Chart.pxRatio;
      const x = plot.valToPos(spec.xs[selected], 'x', true);
      const y = plot.valToPos(spec.ys[selected], 'y', true);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 7 * ratio, 0, Math.PI * 2);
      ctx.fillStyle = colors.accent;
      ctx.fill();
      ctx.lineWidth = 2 * ratio;
      ctx.strokeStyle = colors.surface;
      ctx.stroke();
      ctx.restore();
    };

    const options: UPlot.Options = {
      width,
      height: CHART_HEIGHT,
      padding: [14, 16, 0, 0],
      legend: { show: false },
      cursor: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: {
        x: { time: false, range: () => [spec.xRange[0], spec.xRange[1]] },
        y: { range: () => [spec.yRange[0], spec.yRange[1]] },
      },
      axes: [
        {
          stroke: () => colors.ink2,
          font: font(12),
          size: 36,
          gap: 12,
          ticks: { show: false },
          grid: { show: false },
          border: { show: false },
          splits: () => [...spec.xTicks],
          values: (_plot, splits) => splits.map((value) => spec.formatX(value)),
        },
        {
          stroke: () => colors.ink2,
          font: font(12),
          size: 44,
          gap: 8,
          ticks: { show: false },
          grid: { stroke: () => colors.line, width: 1 },
          border: { show: false },
          splits: () => [...spec.yTicks],
          values: (_plot, splits) => splits.map((value) => spec.formatY(value)),
        },
      ],
      series: [
        {},
        {
          // A tendência: linha cheia, sem pontos.
          stroke: () => colors.accent,
          width: 2.5,
          points: { show: false },
        },
        {
          // As pesagens: só os pontos (anéis), sem linha ligando.
          stroke: () => colors.ink2,
          width: 0,
          paths: () => null,
          points: {
            show: true,
            size: 7,
            width: 1.5,
            stroke: () => colors.ink2,
            fill: () => colors.surface,
          },
        },
      ],
      hooks: { draw: [drawOverlay] },
    };

    const plot = new Chart(options, dataOf(spec), host);

    // Toque no gráfico escolhe a pesagem mais perto na horizontal (no celular o alvo é a coluna inteira, não o pontinho).
    const pick = (event: MouseEvent) => {
      const box = plot.over.getBoundingClientRect();
      const index = nearestIndex(spec.xs, plot.posToVal(event.clientX - box.left, 'x'));
      if (index >= 0) events.onPick(index);
    };
    plot.over.addEventListener('click', pick);

    const stopWatching = watchTheme(doc, () => {
      colors = readChartColors(host);
      plot.redraw(true, false);
    });

    return {
      update(next) {
        spec = next;
        plot.setData(dataOf(next));
      },
      setWidth(next) {
        plot.setSize({ width: next, height: CHART_HEIGHT });
      },
      destroy() {
        stopWatching();
        plot.over.removeEventListener('click', pick);
        plot.destroy();
      },
    };
  },
};

/**
 * O motor do gráfico de peso. É uma porta, como a do gráfico de Progresso: o teste de unidade troca por um falso (o jsdom
 * não tem canvas). O cartão do peso a entrega ao componente do gráfico no lugar do motor de uma série só.
 */
export const WEIGHT_CHART_ENGINE = new InjectionToken<ChartEngine>('body weight chart engine', {
  providedIn: 'root',
  factory: () => weightChartEngine,
});

/** O provedor que o cartão do peso põe em `providers`: o componente de gráfico, mais abaixo, pede `CHART_ENGINE`. */
export const WEIGHT_CHART_PROVIDER = {
  provide: CHART_ENGINE,
  useExisting: WEIGHT_CHART_ENGINE,
} as const;
