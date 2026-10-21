import type UPlot from 'uplot';
import { nearestIndex } from './chart-model';
import { readChartColors, watchTheme } from './chart-theme';
import { CHART_HEIGHT, type ChartEngine, type ChartHandle, type ChartSpec } from './chart-types';

/** Dados no formato da biblioteca: o eixo do tempo e uma série. */
function dataOf(spec: ChartSpec): UPlot.AlignedData {
  return [[...spec.xs], [...spec.ys]];
}

/**
 * A biblioteca de gráficos (uPlot, MIT, sem dependências). Só este arquivo a conhece, e só por importação dinâmica: o
 * pacote inicial do app não carrega nem uma linha dela, e ela só baixa quando a tela de Progresso tem o que desenhar. O
 * pedaço dela entra no cache do app como qualquer outro, então funciona sem rede depois da primeira vez. (O uPlot mede a
 * densidade de pixels com `matchMedia` ao ser carregado, o que o jsdom dos testes não tem: a importação dinâmica também
 * evita que carregar a tela, num teste de unidade, já quebre.)
 *
 * Tudo que o desenho precisa de estilo vem do tema do app (`chart-theme`) e é lido de novo quando o tema muda. A
 * biblioteca só atribui propriedades de estilo pelo DOM (`el.style.x = ...`), que a política de segurança do app permite;
 * ela não escreve atributo `style` nem cria `<style>`.
 */
export const uplotEngine: ChartEngine = {
  async create(host, initial, width, events): Promise<ChartHandle> {
    const { default: Chart } = await import('uplot');
    const doc = host.ownerDocument;
    let spec = initial;
    let colors = readChartColors(host);

    const font = (size: number, weight = 400) => `${weight} ${size}px ${colors.font}`;

    // Por cima do desenho: a linha da meta (tracejada e com rótulo) e o ponto em destaque.
    const drawOverlay = (plot: UPlot) => {
      const ctx = plot.ctx;
      const ratio = Chart.pxRatio;
      const { left, width: plotWidth } = plot.bbox;

      if (spec.goal !== null) {
        const y = plot.valToPos(spec.goal.value, 'y', true);
        ctx.save();
        ctx.setLineDash([6 * ratio, 4 * ratio]);
        ctx.lineWidth = 2 * ratio;
        ctx.strokeStyle = colors.goal;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = font(12 * ratio, 600);
        ctx.fillStyle = colors.goal;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(spec.goal.label, left + 6 * ratio, y - 4 * ratio);
        ctx.restore();
      }

      const selected = spec.selected;
      if (selected !== null && selected < spec.xs.length) {
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
      }
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
          size: 28,
          gap: 4,
          ticks: { show: false },
          grid: { show: false },
          border: { show: false },
          splits: () => [...spec.xTicks],
          values: (_plot, splits) => splits.map((value) => spec.formatX(value)),
        },
        {
          stroke: () => colors.ink2,
          font: font(12),
          size: 38,
          gap: 4,
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
          stroke: () => colors.accent,
          width: 2.5,
          points: {
            show: true,
            size: 8,
            width: 2,
            stroke: () => colors.accent,
            fill: () => colors.surface,
          },
        },
      ],
      hooks: { draw: [drawOverlay] },
    };

    const plot = new Chart(options, dataOf(spec), host);

    // Toque no gráfico escolhe o ponto mais perto na horizontal (no celular o alvo é a coluna inteira, não o pontinho).
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
