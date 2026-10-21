import type { ChartEngine, ChartEvents, ChartHandle, ChartSpec } from './chart-types';

/**
 * Motor de gráfico falso dos testes: o jsdom não tem canvas, então o teste troca a biblioteca por este, que só anota o
 * que a tela mandou desenhar. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */
export class FakeChartEngine implements ChartEngine {
  /** Todas as especificações recebidas, da primeira à última (a criação e cada atualização). */
  readonly specs: ChartSpec[] = [];
  /** Larguras pedidas depois da criação. */
  readonly widths: number[] = [];
  created = 0;
  destroyed = 0;
  events: ChartEvents | null = null;
  /** Quando definido, a criação falha com ele (a biblioteca que não chegou). */
  failWith: Error | null = null;
  /** Enquanto definido, a criação espera por ele (a biblioteca ainda carregando). */
  gate: Promise<void> | null = null;

  async create(
    _host: HTMLElement,
    spec: ChartSpec,
    width: number,
    events: ChartEvents,
  ): Promise<ChartHandle> {
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    this.created++;
    this.events = events;
    this.widths.push(width);
    this.specs.push(spec);
    return {
      update: (next) => void this.specs.push(next),
      setWidth: (next) => void this.widths.push(next),
      destroy: () => void this.destroyed++,
    };
  }

  /** A última especificação desenhada. */
  get last(): ChartSpec {
    return this.specs[this.specs.length - 1];
  }
}
