import type { components } from '../../../../core/api/generated/schema';
import { type FatMethod, isFatMethod } from '../../domain/body/body-limits';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';
import { newestWins } from '../sync/merge';

/** A medição como a API a entrega (tipo gerado do OpenAPI). */
export type BodyEntryDto = components['schemas']['BodyEntryResponse'];

/** O corpo do `PUT` da medição (tipo gerado do OpenAPI). */
export type BodyEntryUpsertBody = components['schemas']['UpsertBodyEntryRequest'];

/**
 * Linha do banco local da medição. `measuredOn` é o dia local do aparelho (`AAAA-MM-DD`); os outros instantes ficam em
 * milissegundos. Apagar é lápide (`deletedAt`) com os valores esvaziados: a linha fica para o apagamento valer em todo
 * aparelho, e o servidor também não guarda dado de saúde de medição apagada.
 */
export interface LocalBodyEntry {
  readonly id: string;
  readonly measuredOn: string;
  readonly weightKg: number | null;
  readonly bodyFatPct: number | null;
  readonly fatMethod: FatMethod | null;
  readonly waistCm: number | null;
  readonly neckCm: number | null;
  readonly hipCm: number | null;
  readonly armCm: number | null;
  readonly thighCm: number | null;
  readonly chestCm?: number | null;
  readonly abdomenCm?: number | null;
  readonly forearmCm?: number | null;
  readonly calfCm?: number | null;
  readonly armRightCm?: number | null;
  readonly armLeftCm?: number | null;
  readonly forearmRightCm?: number | null;
  readonly forearmLeftCm?: number | null;
  readonly thighRightCm?: number | null;
  readonly thighLeftCm?: number | null;
  readonly calfRightCm?: number | null;
  readonly calfLeftCm?: number | null;
  readonly chestSkinfoldMm?: number | null;
  readonly abdomenSkinfoldMm?: number | null;
  readonly thighSkinfoldMm?: number | null;
  readonly note: string;
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
  /** Instante em que foi apagada, ou `null` se está viva. */
  readonly deletedAt: number | null;
}

/** Os campos que guardam valor de saúde (esvaziados na lápide). */
const EMPTY_VALUES = {
  weightKg: null,
  bodyFatPct: null,
  fatMethod: null,
  waistCm: null,
  neckCm: null,
  hipCm: null,
  armCm: null,
  thighCm: null,
  chestCm: null,
  abdomenCm: null,
  forearmCm: null,
  calfCm: null,
  armRightCm: null,
  armLeftCm: null,
  forearmRightCm: null,
  forearmLeftCm: null,
  thighRightCm: null,
  thighLeftCm: null,
  calfRightCm: null,
  calfLeftCm: null,
  chestSkinfoldMm: null,
  abdomenSkinfoldMm: null,
  thighSkinfoldMm: null,
  note: '',
} as const;

/** A mesma linha como lápide: sem nenhum valor de saúde. */
export function asTombstone(row: LocalBodyEntry, at: number): LocalBodyEntry {
  return { ...row, ...EMPTY_VALUES, updatedAt: at, clientUpdatedAt: at, deletedAt: at };
}

/** Converte a resposta da API na linha local. Único lugar que lida com as particularidades do tipo gerado. */
export function toLocalBodyEntry(dto: BodyEntryDto): LocalBodyEntry {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  const deleted = dto.deleted;
  return {
    id: dto.id,
    measuredOn: dto.measuredOn,
    weightKg: deleted ? null : toNumberOrNull(dto.weightKg),
    bodyFatPct: deleted ? null : toNumberOrNull(dto.bodyFatPct),
    fatMethod: !deleted && isFatMethod(dto.fatMethod) ? dto.fatMethod : null,
    waistCm: deleted ? null : toNumberOrNull(dto.waistCm),
    neckCm: deleted ? null : toNumberOrNull(dto.neckCm),
    hipCm: deleted ? null : toNumberOrNull(dto.hipCm),
    armCm: deleted ? null : toNumberOrNull(dto.armCm),
    thighCm: deleted ? null : toNumberOrNull(dto.thighCm),
    chestCm: deleted ? null : toNumberOrNull(dto.chestCm),
    abdomenCm: deleted ? null : toNumberOrNull(dto.abdomenCm),
    forearmCm: deleted ? null : toNumberOrNull(dto.forearmCm),
    calfCm: deleted ? null : toNumberOrNull(dto.calfCm),
    armRightCm: deleted ? null : toNumberOrNull(dto.armRightCm),
    armLeftCm: deleted ? null : toNumberOrNull(dto.armLeftCm),
    forearmRightCm: deleted ? null : toNumberOrNull(dto.forearmRightCm),
    forearmLeftCm: deleted ? null : toNumberOrNull(dto.forearmLeftCm),
    thighRightCm: deleted ? null : toNumberOrNull(dto.thighRightCm),
    thighLeftCm: deleted ? null : toNumberOrNull(dto.thighLeftCm),
    calfRightCm: deleted ? null : toNumberOrNull(dto.calfRightCm),
    calfLeftCm: deleted ? null : toNumberOrNull(dto.calfLeftCm),
    chestSkinfoldMm: deleted ? null : toNumberOrNull(dto.chestSkinfoldMm),
    abdomenSkinfoldMm: deleted ? null : toNumberOrNull(dto.abdomenSkinfoldMm),
    thighSkinfoldMm: deleted ? null : toNumberOrNull(dto.thighSkinfoldMm),
    note: deleted ? '' : (dto.note ?? ''),
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: deleted ? updatedAt : null,
  };
}

/** O corpo do `PUT`: a medição inteira; `deleted` sai da lápide da linha (e os valores vão vazios). */
export function toBodyEntryBody(row: LocalBodyEntry): BodyEntryUpsertBody {
  const deleted = row.deletedAt !== null;
  return {
    measuredOn: row.measuredOn,
    weightKg: deleted ? null : row.weightKg,
    bodyFatPct: deleted ? null : row.bodyFatPct,
    fatMethod: deleted ? null : row.fatMethod,
    waistCm: deleted ? null : row.waistCm,
    neckCm: deleted ? null : row.neckCm,
    hipCm: deleted ? null : row.hipCm,
    armCm: deleted ? null : row.armCm,
    thighCm: deleted ? null : row.thighCm,
    chestCm: deleted ? null : (row.chestCm ?? null),
    abdomenCm: deleted ? null : (row.abdomenCm ?? null),
    forearmCm: deleted ? null : (row.forearmCm ?? null),
    calfCm: deleted ? null : (row.calfCm ?? null),
    armRightCm: deleted ? null : (row.armRightCm ?? null),
    armLeftCm: deleted ? null : (row.armLeftCm ?? null),
    forearmRightCm: deleted ? null : (row.forearmRightCm ?? null),
    forearmLeftCm: deleted ? null : (row.forearmLeftCm ?? null),
    thighRightCm: deleted ? null : (row.thighRightCm ?? null),
    thighLeftCm: deleted ? null : (row.thighLeftCm ?? null),
    calfRightCm: deleted ? null : (row.calfRightCm ?? null),
    calfLeftCm: deleted ? null : (row.calfLeftCm ?? null),
    chestSkinfoldMm: deleted ? null : (row.chestSkinfoldMm ?? null),
    abdomenSkinfoldMm: deleted ? null : (row.abdomenSkinfoldMm ?? null),
    thighSkinfoldMm: deleted ? null : (row.thighSkinfoldMm ?? null),
    note: deleted || row.note.trim() === '' ? null : row.note.trim(),
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted,
  };
}

/**
 * Decide entre a medição local e a que veio do servidor: vale o `clientUpdatedAt` mais novo, e no empate o servidor (o
 * puxar só roda com a fila vazia, então o servidor já viu tudo o que este aparelho mandou). A lápide é uma linha como as
 * outras.
 */
export function resolveBodyEntry(local: LocalBodyEntry, remote: LocalBodyEntry): LocalBodyEntry {
  return newestWins(local, remote);
}
