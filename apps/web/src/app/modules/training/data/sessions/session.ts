import type { components } from '../../../../core/api/generated/schema';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';
import type { SessionModel, SetModel, SetType } from '../../domain/session/session-model';
import { newestWins } from '../sync/merge';

/** O treino como a API o entrega (tipo gerado do OpenAPI). */
export type SessionDto = components['schemas']['SessionResponse'];

/** A série como a API a entrega (tipo gerado do OpenAPI). */
export type SetDto = components['schemas']['SetResponse'];

/** Corpos dos `PUT` (tipos gerados do OpenAPI). */
export type SessionUpsertBody = components['schemas']['UpsertSessionRequest'];
export type SetUpsertBody = components['schemas']['UpsertSetRequest'];

/**
 * Linha do banco local do treino. Os instantes ficam em milissegundos. Apagar é lápide (`deletedAt`): a linha fica para
 * o apagamento valer em todo aparelho.
 */
export interface LocalSession extends SessionModel {
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
  /** Instante em que foi apagado, ou `null` se está vivo. */
  readonly deletedAt: number | null;
}

/** Linha do banco local da série (mesmas regras da `LocalSession`). */
export interface LocalSet extends SetModel {
  readonly updatedAt: number;
  readonly clientUpdatedAt: number;
  readonly deletedAt: number | null;
}

/** Converte a resposta da API na linha local. Único lugar que lida com as particularidades do tipo gerado. */
export function toLocalSession(dto: SessionDto): LocalSession {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    routineId: dto.routineId,
    startedAt: parseInstant(dto.startedAt) ?? updatedAt,
    finishedAt: parseInstant(dto.finishedAt),
    note: dto.note ?? '',
    feeling: toNumberOrNull(dto.feeling),
    deviceId: dto.deviceId,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

export function toLocalSet(dto: SetDto): LocalSet {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    sessionId: dto.sessionId,
    exerciseId: dto.exerciseId,
    position: toNumberOrNull(dto.position) ?? 0,
    setType: dto.setType as SetType,
    weightKg: toNumberOrNull(dto.weightKg),
    reps: toNumberOrNull(dto.reps),
    durationS: toNumberOrNull(dto.durationS),
    rir: toNumberOrNull(dto.rir),
    rpe: toNumberOrNull(dto.rpe),
    note: dto.note ?? '',
    completedAt: parseInstant(dto.completedAt) ?? updatedAt,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

/** O corpo do `PUT` do treino: sempre inteiro; `deleted` sai da lápide da linha. */
export function toSessionBody(row: LocalSession): SessionUpsertBody {
  return {
    routineId: row.routineId,
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
    note: row.note.trim() === '' ? null : row.note,
    feeling: row.feeling,
    deviceId: row.deviceId,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted: row.deletedAt !== null,
  };
}

/** O corpo do `PUT` da série: sempre inteiro; `deleted` sai da lápide da linha. */
export function toSetBody(row: LocalSet): SetUpsertBody {
  return {
    exerciseId: row.exerciseId,
    position: row.position,
    setType: row.setType,
    weightKg: row.weightKg,
    reps: row.reps,
    durationS: row.durationS,
    rir: row.rir,
    rpe: row.rpe,
    note: row.note.trim() === '' ? null : row.note,
    completedAt: new Date(row.completedAt).toISOString(),
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted: row.deletedAt !== null,
  };
}

/**
 * Decide entre a linha local e a que veio do servidor: vale o `clientUpdatedAt` mais novo, e no empate o servidor (o
 * puxar só roda com a fila vazia, então o servidor já viu tudo o que este aparelho mandou).
 */
export function resolveSession(local: LocalSession, remote: LocalSession): LocalSession {
  return newestWins(local, remote);
}

export function resolveSet(local: LocalSet, remote: LocalSet): LocalSet {
  return newestWins(local, remote);
}
