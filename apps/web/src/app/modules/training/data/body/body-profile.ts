import type { components } from '../../../../core/api/generated/schema';
import {
  type BodyProfileValues,
  DEFAULT_ACTIVITY_FACTOR,
  isBodySex,
} from '../../domain/body/body-limits';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';
import { newestWins } from '../sync/merge';

/** O perfil como a API o entrega (tipo gerado do OpenAPI). */
export type BodyProfileDto = components['schemas']['BodyProfileResponse'];

/** O corpo do `PUT` do perfil (tipo gerado do OpenAPI). */
export type BodyProfileUpsertBody = components['schemas']['UpsertBodyProfileRequest'];

/** O perfil é um só por pessoa: a linha local tem sempre este `id`. */
export const BODY_PROFILE_ROW_ID = 'me';

/**
 * Linha do banco local do perfil (uma só). Não há lápide: o perfil só troca de valor. O local vence até o servidor
 * confirmar (mesmo critério de fusão das demais escritas: o `clientUpdatedAt` mais novo).
 */
export interface LocalBodyProfile extends BodyProfileValues {
  readonly id: typeof BODY_PROFILE_ROW_ID;
  /** Relógio do servidor na última gravação; só informativo. */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
}

/**
 * Converte a resposta da API na linha local. Perfil com sexo que esta versão do app não conhece (ou sem altura) vira `null`:
 * é ignorado, e o dado continua no servidor para uma versão mais nova.
 */
export function toLocalBodyProfile(dto: BodyProfileDto): LocalBodyProfile | null {
  const heightCm = toNumberOrNull(dto.heightCm);
  if (heightCm === null || !isBodySex(dto.sex)) return null;
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: BODY_PROFILE_ROW_ID,
    heightCm,
    birthDate: dto.birthDate,
    sex: dto.sex,
    activityFactor: toNumberOrNull(dto.activityFactor) ?? DEFAULT_ACTIVITY_FACTOR,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
  };
}

/** O corpo do `PUT`: o perfil inteiro. */
export function toBodyProfileBody(row: LocalBodyProfile): BodyProfileUpsertBody {
  return {
    heightCm: row.heightCm,
    birthDate: row.birthDate,
    sex: row.sex,
    activityFactor: row.activityFactor,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
  };
}

/** Decide entre o perfil local e o que veio do servidor: o `clientUpdatedAt` mais novo, e no empate o servidor. */
export function resolveBodyProfile(
  local: LocalBodyProfile,
  remote: LocalBodyProfile,
): LocalBodyProfile {
  return newestWins(local, remote);
}
