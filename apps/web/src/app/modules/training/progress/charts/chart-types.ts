/**
 * O que o desenho do gráfico recebe e devolve, sem nada da biblioteca: a tela fala só com estes tipos, e a biblioteca
 * escolhida fica atrás de `ChartEngine` (carregada sob demanda). Trocar de biblioteca, ou usar uma falsa nos testes, não
 * mexe na tela.
 */

/** Altura do desenho em px (a largura vem do cartão). */
export const CHART_HEIGHT = 172;

export interface ChartGoal {
  /** O valor da meta no eixo de carga. */
  readonly value: number;
  /** O texto da linha tracejada ("meta 55 kg"): a linha tem rótulo, não depende só da cor. */
  readonly label: string;
}

export interface ChartSpec {
  /** Posições no eixo do tempo, em segundos, e os valores, um por ponto. */
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  readonly xTicks: readonly number[];
  readonly yTicks: readonly number[];
  readonly goal: ChartGoal | null;
  /** O ponto em destaque (o que o texto acima do gráfico descreve), ou `null`. */
  readonly selected: number | null;
  readonly formatX: (seconds: number) => string;
  readonly formatY: (value: number) => string;
}

export interface ChartEvents {
  /** O dedo (ou o mouse) tocou o gráfico: o ponto mais perto do toque. */
  onPick(index: number): void;
}

export interface ChartHandle {
  update(spec: ChartSpec): void;
  setWidth(width: number): void;
  destroy(): void;
}

export interface ChartEngine {
  create(
    host: HTMLElement,
    spec: ChartSpec,
    width: number,
    events: ChartEvents,
  ): Promise<ChartHandle>;
}
