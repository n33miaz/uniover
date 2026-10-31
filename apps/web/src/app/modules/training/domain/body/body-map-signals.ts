import type { LocalBodyEntry } from '../../data/body/body-entry';
import { round1 } from './rounding';

/** As regiões do corpo que o mapa pinta; cada uma agrupa uma ou mais medidas (com ou sem lado). */
export type BodyMapRegion = 'chest' | 'abdomen' | 'arm' | 'forearm' | 'thigh' | 'calf';
export type BodyMapChange = 'up' | 'same' | 'down' | 'neutral';
export type BodySide = 'right' | 'left';

type MeasureKey = keyof LocalBodyEntry;

/** Um par direito/esquerdo de uma região com lado. */
export interface BodyMapSymmetry {
  readonly rightCm: number;
  readonly leftCm: number;
  /** Diferença absoluta, em uma casa. */
  readonly differenceCm: number;
  /** Lado maior; `null` quando os dois são iguais. */
  readonly larger: BodySide | null;
}

export interface BodyMapSignal {
  readonly region: BodyMapRegion;
  /** Evolução entre as duas medições mais recentes que tenham a mesma medida. */
  readonly change: BodyMapChange;
  /** Direito × esquerdo da medição mais recente que tem os dois lados; `null` sem os dois (ou sem lado na região). */
  readonly symmetry: BodyMapSymmetry | null;
  /** Alguma medição registrou ao menos um dos lados (a tela só abre o cartão de simetria de quem já usa os lados). */
  readonly hasSides: boolean;
}

/** Medidas de cada região. O campo sem lado vem de registros antigos e segue valendo para a evolução. */
export const REGION_FIELDS: Readonly<Record<BodyMapRegion, readonly MeasureKey[]>> = {
  chest: ['chestCm'],
  abdomen: ['abdomenCm'],
  arm: ['armRightCm', 'armLeftCm', 'armCm'],
  forearm: ['forearmRightCm', 'forearmLeftCm', 'forearmCm'],
  thigh: ['thighRightCm', 'thighLeftCm', 'thighCm'],
  calf: ['calfRightCm', 'calfLeftCm', 'calfCm'],
};

/** As regiões que têm direito e esquerdo. */
export const SIDE_FIELDS: Readonly<
  Partial<Record<BodyMapRegion, readonly [MeasureKey, MeasureKey]>>
> = {
  arm: ['armRightCm', 'armLeftCm'],
  forearm: ['forearmRightCm', 'forearmLeftCm'],
  thigh: ['thighRightCm', 'thighLeftCm'],
  calf: ['calfRightCm', 'calfLeftCm'],
};

/** A partir de quantos centímetros a diferença entre os lados passa a ser destacada. */
export const SYMMETRY_RELEVANT_CM = 0.5;

const present = (row: LocalBodyEntry, field: MeasureKey): number | null => {
  const raw = row[field];
  return typeof raw === 'number' ? raw : null;
};

/** As medidas da região que a medição tem, por campo. */
function regionValues(row: LocalBodyEntry, region: BodyMapRegion): Map<MeasureKey, number> {
  const found = new Map<MeasureKey, number>();
  for (const field of REGION_FIELDS[region]) {
    const value = present(row, field);
    if (value !== null) found.set(field, value);
  }
  return found;
}

/** Média só dos campos pedidos; quem compara usa os campos que as duas medições têm em comum. */
function mean(values: ReadonlyMap<MeasureKey, number>, fields: readonly MeasureKey[]): number {
  return fields.reduce((total, field) => total + values.get(field)!, 0) / fields.length;
}

/**
 * Evolução da região: a medição mais recente com valor contra a anterior mais próxima que **mede a mesma coisa** (o mesmo
 * lado). Comparar o braço direito de hoje com a média dos dois braços de antes inventaria uma evolução que não houve.
 * Sem duas medições comparáveis o resultado é neutro, nunca um dado simulado.
 */
function changeOf(rows: readonly LocalBodyEntry[], region: BodyMapRegion): BodyMapChange {
  const withValue = rows
    .map((row) => regionValues(row, region))
    .filter((values) => values.size > 0);
  const [latest, ...older] = withValue;
  if (latest === undefined) return 'neutral';
  for (const previous of older) {
    const shared = [...latest.keys()].filter((field) => previous.has(field));
    if (shared.length === 0) continue;
    const now = round1(mean(latest, shared));
    const before = round1(mean(previous, shared));
    return now > before ? 'up' : now < before ? 'down' : 'same';
  }
  return 'neutral';
}

function hasSidesOf(rows: readonly LocalBodyEntry[], region: BodyMapRegion): boolean {
  const fields = SIDE_FIELDS[region];
  return (
    fields !== undefined && rows.some((row) => fields.some((field) => present(row, field) !== null))
  );
}

function symmetryOf(
  rows: readonly LocalBodyEntry[],
  region: BodyMapRegion,
): BodyMapSymmetry | null {
  const fields = SIDE_FIELDS[region];
  if (!fields) return null;
  for (const row of rows) {
    const rightCm = present(row, fields[0]);
    const leftCm = present(row, fields[1]);
    if (rightCm === null || leftCm === null) continue;
    const differenceCm = round1(Math.abs(rightCm - leftCm));
    return {
      rightCm,
      leftCm,
      differenceCm,
      larger: differenceCm === 0 ? null : rightCm > leftCm ? 'right' : 'left',
    };
  }
  return null;
}

/** As seis regiões do mapa, calculadas das medições locais (da mais antiga à mais nova, como o repositório devolve). */
export function bodyMapSignals(entries: readonly LocalBodyEntry[]): readonly BodyMapSignal[] {
  const newestFirst = entries.filter((entry) => entry.deletedAt === null).reverse();
  return (Object.keys(REGION_FIELDS) as BodyMapRegion[]).map((region) => ({
    region,
    change: changeOf(newestFirst, region),
    symmetry: symmetryOf(newestFirst, region),
    hasSides: hasSidesOf(newestFirst, region),
  }));
}
