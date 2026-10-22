/**
 * Modelo e limites do corpo (medições e perfil). Tipos e funções puras: nada de Angular, banco ou rede. Os limites são os
 * mesmos da API, para o que ela recusaria nem entrar na fila de escrita. São faixas de bom senso contra digitação errada,
 * não uma opinião sobre saúde.
 */

import { parseDateKey } from './date-key';

/** Como o percentual de gordura foi obtido (mesmos valores da API). */
export const FAT_METHODS = ['navy', 'manual', 'bioimpedance'] as const;
export type FatMethod = (typeof FAT_METHODS)[number];

export const isFatMethod = (value: string | null | undefined): value is FatMethod =>
  FAT_METHODS.includes(value as FatMethod);

/** Sexo para as fórmulas (que são por sexo; mesmos valores da API). */
export const BODY_SEXES = ['male', 'female'] as const;
export type BodySex = (typeof BODY_SEXES)[number];

export const isBodySex = (value: string | null | undefined): value is BodySex =>
  BODY_SEXES.includes(value as BodySex);

/** Fator de atividade assumido quando o dono não escolheu outro (editável). */
export const DEFAULT_ACTIVITY_FACTOR = 1.55;

interface Range {
  readonly min: number;
  readonly max: number;
  /** Casas decimais que o banco guarda. */
  readonly decimals: number;
}

export const BODY_LIMITS = {
  weightKg: { min: 20, max: 400, decimals: 2 },
  bodyFatPct: { min: 2, max: 70, decimals: 1 },
  circumferenceCm: { min: 10, max: 250, decimals: 1 },
  heightCm: { min: 100, max: 250, decimals: 1 },
  activityFactor: { min: 1, max: 2.5, decimals: 2 },
  noteMax: 300,
  /** Data mais antiga aceita (nascimento e medição). */
  earliestDate: '1900-01-01',
} as const satisfies Record<string, Range | number | string>;

/** Menor idade para os cálculos de gordura, gasto e meta (o app é pessoal e não atende menores). */
export const ADULT_AGE_YEARS = 18;

/** O valor tem no máximo `decimals` casas? Tolerante ao ruído de ponto flutuante (82.45 * 100 não dá inteiro exato). */
function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function inRange(value: number, range: Range): boolean {
  return (
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max &&
    hasAtMostDecimals(value, range.decimals)
  );
}

/** Os valores medidos de uma medição; todos opcionais, mas a medição viva precisa de pelo menos um. */
export interface BodyEntryValues {
  readonly weightKg: number | null;
  readonly bodyFatPct: number | null;
  readonly fatMethod: FatMethod | null;
  readonly waistCm: number | null;
  readonly neckCm: number | null;
  readonly hipCm: number | null;
  readonly armCm: number | null;
  readonly thighCm: number | null;
  readonly note: string;
}

export type BodyEntryIssueCode =
  | 'empty'
  | 'date-invalid'
  | 'value-range'
  | 'fat-method-required'
  | 'fat-method-without-fat'
  | 'note-too-long';

/** O que está errado numa medição, sem texto: a tela escolhe a mensagem (i18n). */
export interface BodyEntryIssue {
  readonly path: BodyEntryIssuePath;
  readonly code: BodyEntryIssueCode;
}

/** O campo com problema; `values` é "não há nenhum valor medido". */
export type BodyEntryIssuePath = NumericEntryField | 'fatMethod' | 'note' | 'measuredOn' | 'values';

type NumericEntryField =
  'weightKg' | 'bodyFatPct' | 'waistCm' | 'neckCm' | 'hipCm' | 'armCm' | 'thighCm';

/** Campos numéricos da medição e a faixa de cada um. */
const ENTRY_RANGES: readonly (readonly [NumericEntryField, Range])[] = [
  ['weightKg', BODY_LIMITS.weightKg],
  ['bodyFatPct', BODY_LIMITS.bodyFatPct],
  ['waistCm', BODY_LIMITS.circumferenceCm],
  ['neckCm', BODY_LIMITS.circumferenceCm],
  ['hipCm', BODY_LIMITS.circumferenceCm],
  ['armCm', BODY_LIMITS.circumferenceCm],
  ['thighCm', BODY_LIMITS.circumferenceCm],
];

/** A medição tem ao menos um valor medido (a anotação sozinha não conta)? */
export function hasAnyBodyValue(values: BodyEntryValues): boolean {
  return ENTRY_RANGES.some(([key]) => values[key] !== null);
}

/** A data existe e está dentro do intervalo aceito (de 1900 até `latest`, inclusive). */
function isDateWithin(date: string, latest: string): boolean {
  return parseDateKey(date) !== null && date >= BODY_LIMITS.earliestDate && date <= latest;
}

/**
 * Confere a medição com os mesmos limites da API. Lista vazia = pode gravar. `latestAllowedDate` é o último dia aceito
 * (`AAAA-MM-DD`): o dia de hoje do aparelho mais um de folga, porque a API também dá um dia à frente da data dela (fuso).
 */
export function validateBodyEntry(
  measuredOn: string,
  values: BodyEntryValues,
  latestAllowedDate: string,
): BodyEntryIssue[] {
  const issues: BodyEntryIssue[] = [];

  if (!isDateWithin(measuredOn, latestAllowedDate)) {
    issues.push({ path: 'measuredOn', code: 'date-invalid' });
  }

  for (const [key, range] of ENTRY_RANGES) {
    const value = values[key];
    if (value !== null && !inRange(value, range)) {
      issues.push({ path: key, code: 'value-range' });
    }
  }

  if (values.bodyFatPct !== null && values.fatMethod === null) {
    issues.push({ path: 'fatMethod', code: 'fat-method-required' });
  } else if (values.bodyFatPct === null && values.fatMethod !== null) {
    issues.push({ path: 'fatMethod', code: 'fat-method-without-fat' });
  }

  if (values.note.trim().length > BODY_LIMITS.noteMax) {
    issues.push({ path: 'note', code: 'note-too-long' });
  }

  if (!hasAnyBodyValue(values)) {
    issues.push({ path: 'values', code: 'empty' });
  }
  return issues;
}

/** O perfil que as fórmulas pedem. */
export interface BodyProfileValues {
  readonly heightCm: number;
  /** `AAAA-MM-DD`. */
  readonly birthDate: string;
  readonly sex: BodySex;
  readonly activityFactor: number;
}

export type BodyProfileIssueCode = 'value-range' | 'date-invalid' | 'sex-invalid';

export interface BodyProfileIssue {
  readonly path: 'heightCm' | 'birthDate' | 'sex' | 'activityFactor';
  readonly code: BodyProfileIssueCode;
}

/** Confere o perfil com os mesmos limites da API. `today` é o dia de hoje do aparelho (nascimento no futuro é erro). */
export function validateBodyProfile(profile: BodyProfileValues, today: string): BodyProfileIssue[] {
  const issues: BodyProfileIssue[] = [];
  if (!inRange(profile.heightCm, BODY_LIMITS.heightCm)) {
    issues.push({ path: 'heightCm', code: 'value-range' });
  }
  if (!isDateWithin(profile.birthDate, today)) {
    issues.push({ path: 'birthDate', code: 'date-invalid' });
  }
  if (!isBodySex(profile.sex)) {
    issues.push({ path: 'sex', code: 'sex-invalid' });
  }
  if (!inRange(profile.activityFactor, BODY_LIMITS.activityFactor)) {
    issues.push({ path: 'activityFactor', code: 'value-range' });
  }
  return issues;
}
