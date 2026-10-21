/**
 * Intensidade do desenho: quantas séries de trabalho o músculo teve na semana, em quatro degraus. É só uma escala para o
 * olho comparar um músculo com o outro; o app mostra o que foi feito e não recomenda número de séries (não há norma única).
 * O degrau nunca vai sozinho na tela: a legenda traz as faixas em número, e o painel e o rótulo da zona trazem a contagem.
 */
export type Intensity = 0 | 1 | 2 | 3;

interface Band {
  readonly level: Exclude<Intensity, 0>;
  /** Primeira contagem da faixa. */
  readonly from: number;
  /** Última contagem da faixa, ou `null` para "daí em diante". */
  readonly to: number | null;
}

const BANDS: readonly Band[] = [
  { level: 1, from: 1, to: 3 },
  { level: 2, from: 4, to: 9 },
  { level: 3, from: 10, to: null },
];

export function intensityOf(sets: number): Intensity {
  const band = BANDS.find((item) => sets >= item.from && (item.to === null || sets <= item.to));
  return band ? band.level : 0;
}

export interface LegendStep {
  readonly level: Intensity;
  /** A faixa como número: "0", "1–3", "4–9", "10+". */
  readonly range: string;
}

/** Os degraus da legenda, do mais claro ao mais forte. */
export function legendSteps(): LegendStep[] {
  return [
    { level: 0, range: '0' },
    ...BANDS.map((band) => ({
      level: band.level,
      range: band.to === null ? `${band.from}+` : `${band.from}–${band.to}`,
    })),
  ];
}
