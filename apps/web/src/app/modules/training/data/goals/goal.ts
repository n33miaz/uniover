import type { components } from '../../../../core/api/generated/schema';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';
import { type GoalKind, goalKey, isGoalKind } from '../../domain/progress/goal-model';
import { newestWins } from '../sync/merge';

/** A meta como a API a entrega (tipo gerado do OpenAPI). */
export type GoalDto = components['schemas']['GoalResponse'];

/** O corpo do `PUT` da meta (tipo gerado do OpenAPI). */
export type GoalUpsertBody = components['schemas']['UpsertGoalRequest'];

/**
 * Linha do banco local. O `id` é a chave natural (`goalKey`): o aparelho escreve antes de o servidor dar um id. Os
 * instantes ficam em milissegundos. Remover é lápide (`deletedAt`, com `value` vazio): a linha fica para a remoção valer
 * em todo aparelho.
 */
export interface LocalGoal {
  readonly id: string;
  readonly kind: GoalKind;
  /** Exercício da meta de 1RM; `null` nos outros tipos. */
  readonly exerciseId: string | null;
  /** Valor da meta; `null` só na lápide. */
  readonly value: number | null;
  /** Id que o servidor deu à meta, só informativo (vazio enquanto ela não voltou do servidor). */
  readonly serverId: string | null;
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
  /** Instante em que foi removida, ou `null` se está viva. */
  readonly deletedAt: number | null;
}

/**
 * Converte a resposta da API na linha local. Meta de um tipo que esta versão do app não conhece vira `null` (é ignorada, e
 * o dado continua no servidor para uma versão mais nova).
 */
export function toLocalGoal(dto: GoalDto): LocalGoal | null {
  if (!isGoalKind(dto.kind)) return null;
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  const deleted = dto.deleted;
  return {
    id: goalKey(dto.kind, dto.exerciseId),
    kind: dto.kind,
    exerciseId: dto.exerciseId,
    value: deleted ? null : toNumberOrNull(dto.value),
    serverId: dto.id,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: deleted ? updatedAt : null,
  };
}

/** O corpo do `PUT`: a meta inteira; na lápide o valor vai vazio. */
export function toGoalBody(row: LocalGoal): GoalUpsertBody {
  return {
    exerciseId: row.exerciseId,
    value: row.deletedAt === null ? row.value : null,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
  };
}

/**
 * Decide entre a meta local e a que veio do servidor: vale o `clientUpdatedAt` mais novo, e no empate o servidor (o puxar
 * só roda com a fila vazia, então o servidor já viu tudo o que este aparelho mandou). A lápide é uma linha como as outras.
 */
export function resolveGoal(local: LocalGoal, remote: LocalGoal): LocalGoal {
  const winner = newestWins(local, remote);
  // O id do servidor só chega do servidor: não se perde quando a escrita local é a mais nova.
  return winner === local && local.serverId === null && remote.serverId !== null
    ? { ...local, serverId: remote.serverId }
    : winner;
}
