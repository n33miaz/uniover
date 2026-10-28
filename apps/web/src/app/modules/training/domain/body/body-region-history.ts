import type { LocalBodyEntry } from '../../data/body/body-entry';
import { REGION_FIELDS, type BodyMapRegion, type BodySide } from './body-map-signals';
import { round1 } from './rounding';

/** Uma medida da região numa data, com a variação contra a medição anterior do mesmo campo. */
export interface RegionHistoryCell {
  readonly field: string;
  /** `null` para o registro antigo, sem lado. */
  readonly side: BodySide | null;
  readonly valueCm: number;
  /** Variação contra a medição anterior do mesmo campo; `null` na primeira. */
  readonly deltaCm: number | null;
}

export interface RegionHistoryRow {
  readonly id: string;
  readonly measuredOn: string;
  readonly cells: readonly RegionHistoryCell[];
}

const sideOf = (field: string): BodySide | null =>
  field.includes('Right') ? 'right' : field.includes('Left') ? 'left' : null;

/**
 * A evolução de uma região no tempo, da medição mais nova para a mais antiga (a ordem que a folha mostra). Só entram as
 * medições que têm algum valor da região; a variação de cada campo é contra a anterior que mediu o mesmo campo, então um
 * lado ausente nunca vira variação inventada. Recebe as medições da mais antiga para a mais nova, como o repositório devolve.
 */
export function regionHistory(
  entries: readonly LocalBodyEntry[],
  region: BodyMapRegion,
): readonly RegionHistoryRow[] {
  const previousByField = new Map<string, number>();
  const rows: RegionHistoryRow[] = [];
  for (const entry of entries) {
    if (entry.deletedAt !== null) continue;
    const cells: RegionHistoryCell[] = [];
    for (const field of REGION_FIELDS[region]) {
      const raw = entry[field];
      if (typeof raw !== 'number') continue;
      const before = previousByField.get(field);
      cells.push({
        field,
        side: sideOf(field),
        valueCm: raw,
        deltaCm: before === undefined ? null : round1(raw - before),
      });
      previousByField.set(field, raw);
    }
    if (cells.length > 0) rows.push({ id: entry.id, measuredOn: entry.measuredOn, cells });
  }
  return rows.reverse();
}
