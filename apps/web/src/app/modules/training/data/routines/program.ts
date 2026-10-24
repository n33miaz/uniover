import type { components } from '../../../../core/api/generated/schema';
import { parseInstant } from '../catalog/exercise';
import { newestWins } from '../sync/merge';

/** O programa ativo como a API o entrega (tipo gerado do OpenAPI). */
export type ProgramDto = components['schemas']['TrainingProgramResponse'];

/** Id fixo da única linha do programa ativo. */
export const ACTIVE_PROGRAM_ID = 'active';

/**
 * A escolha do programa da semana, uma linha por conta. Os instantes ficam em milissegundos. Não há lápide: escolher
 * outro programa troca o valor. O programa ativo é ESTA linha, nunca inferido das fichas.
 */
export interface LocalProgram {
  readonly id: typeof ACTIVE_PROGRAM_ID;
  readonly programId: string;
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escolheu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
}

export function toLocalProgram(dto: ProgramDto): LocalProgram {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: ACTIVE_PROGRAM_ID,
    programId: dto.programId,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
  };
}

/** O corpo do `PUT /program`. */
export function toProgramBody(row: LocalProgram): { programId: string; clientUpdatedAt: string } {
  return { programId: row.programId, clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString() };
}

/** Decide entre a escolha local e a do servidor: vale o `clientUpdatedAt` mais novo, e no empate o servidor. */
export function resolveProgram(local: LocalProgram, remote: LocalProgram): LocalProgram {
  return newestWins(local, remote);
}
