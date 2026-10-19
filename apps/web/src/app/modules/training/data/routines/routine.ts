import type { components } from '../../../../core/api/generated/schema';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';
import type { RoutineItemModel, RoutineModel } from '../../domain/routines/routine-model';
import { newestWins } from '../sync/merge';

/** A rotina como a API a entrega (tipo gerado do OpenAPI). */
export type RoutineDto = components['schemas']['RoutineResponse'];
type RoutineItemDto = components['schemas']['RoutineItemResponse'];

/** O corpo do `PUT` da rotina inteira (tipo gerado do OpenAPI). */
export type RoutineUpsertBody = components['schemas']['UpsertRoutineRequest'];

/** Os modelos prontos como a API os entrega (tipo gerado do OpenAPI). */
export type RoutineTemplatesDto = components['schemas']['RoutineTemplatesResponse'];

/**
 * Linha do banco local: a rotina com os itens dentro, como a API a guarda. Os instantes ficam em milissegundos.
 * Apagar é lápide (`deletedAt`): a linha fica para o apagamento valer em todo aparelho.
 */
export interface LocalRoutine extends RoutineModel {
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
  /** Instante em que foi apagada, ou `null` se está viva. */
  readonly deletedAt: number | null;
}

/** Um modelo pronto já convertido: números de verdade e os dias como listas de itens. */
export interface RoutineTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly routines: readonly {
    readonly name: string;
    readonly items: readonly {
      readonly exerciseSlug: string;
      readonly targetSets: number;
      readonly repMin: number;
      readonly repMax: number;
      readonly restSeconds: number;
      readonly supersetGroup: number | null;
    }[];
  }[];
}

function toLocalItem(dto: RoutineItemDto): RoutineItemModel {
  return {
    id: dto.id,
    exerciseId: dto.exerciseId,
    position: toNumberOrNull(dto.position) ?? 0,
    targetSets: toNumberOrNull(dto.targetSets) ?? 0,
    repMin: toNumberOrNull(dto.repMin) ?? 0,
    repMax: toNumberOrNull(dto.repMax) ?? 0,
    restSeconds: toNumberOrNull(dto.restSeconds) ?? 0,
    supersetGroup: toNumberOrNull(dto.supersetGroup),
    note: dto.note ?? '',
  };
}

/** Converte a resposta da API na linha local. Único lugar que lida com as particularidades do tipo gerado. */
export function toLocalRoutine(dto: RoutineDto): LocalRoutine {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    name: dto.name,
    position: toNumberOrNull(dto.position) ?? 0,
    active: dto.active,
    note: dto.note ?? '',
    items: dto.items.map(toLocalItem).sort((a, b) => a.position - b.position),
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

/** O corpo do `PUT`: sempre a rotina inteira; na lápide os itens seguem junto, e o servidor os ignora. */
export function toUpsertBody(row: LocalRoutine, deleted: boolean): RoutineUpsertBody {
  return {
    name: row.name,
    position: row.position,
    active: row.active,
    note: row.note.trim() === '' ? null : row.note,
    items: row.items.map((item) => ({
      id: item.id,
      exerciseId: item.exerciseId,
      position: item.position,
      targetSets: item.targetSets,
      repMin: item.repMin,
      repMax: item.repMax,
      restSeconds: item.restSeconds,
      supersetGroup: item.supersetGroup,
      note: item.note.trim() === '' ? null : item.note,
    })),
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted,
  };
}

/**
 * Decide entre a rotina local e a que veio do servidor: vale o `clientUpdatedAt` mais novo, e no empate o servidor
 * (o puxar só roda com a fila vazia, então o servidor já viu tudo o que este aparelho mandou). A lápide é uma linha
 * como as outras: lápide mais nova vence edição mais velha, e edição mais nova vence lápide mais velha.
 */
export function resolveRoutine(local: LocalRoutine, remote: LocalRoutine): LocalRoutine {
  return newestWins(local, remote);
}

/** Converte os modelos prontos da API (números gerados como `number | string`). */
export function toRoutineTemplates(dto: RoutineTemplatesDto): RoutineTemplate[] {
  return dto.items.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    routines: template.routines.map((routine) => ({
      name: routine.name,
      items: routine.items.map((entry) => ({
        exerciseSlug: entry.exerciseSlug,
        targetSets: toNumberOrNull(entry.targetSets) ?? 0,
        repMin: toNumberOrNull(entry.repMin) ?? 0,
        repMax: toNumberOrNull(entry.repMax) ?? 0,
        restSeconds: toNumberOrNull(entry.restSeconds) ?? 0,
        supersetGroup: toNumberOrNull(entry.supersetGroup),
      })),
    })),
  }));
}
