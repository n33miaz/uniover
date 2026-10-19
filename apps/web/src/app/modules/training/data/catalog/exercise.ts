import type { components } from '../../../../core/api/generated/schema';
import { normalizeText } from '../../domain/text-search';

/** O exercício como a API o entrega (tipo gerado do OpenAPI). */
export type ExerciseDto = components['schemas']['ExerciseResponse'];

/** De onde veio o exercício: as duas fontes do catálogo ou o próprio dono. */
export const EXERCISE_SOURCES = ['free_exercise_db', 'wger', 'own'] as const;

/**
 * Linha do banco local. Os instantes ficam em milissegundos (comparação direta, sem texto) e os números anuláveis
 * já convertidos: o gerador de tipos escreve `null | number | string` e a conversão acontece só em
 * `toLocalExercise`, na borda.
 */
export interface LocalExercise {
  readonly id: string;
  readonly slug: string;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly name: string;
  /** Nome sem acento e sem caixa: chave da busca e da ordenação. */
  readonly nameKey: string;
  readonly instructions: readonly string[];
  /** Ids de músculo (taxonomia), do principal para o menos importante. */
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles: readonly string[];
  readonly equipment: string;
  readonly recordType: string;
  /** Salto de carga já mesclado com a escolha do dono; `null` vale o do equipamento. */
  readonly stepKg: number | null;
  /** Instante da escolha de salto do dono; `null` enquanto ele nunca escolheu (e o servidor não tem escolha). */
  readonly stepClientUpdatedAt: number | null;
  readonly level: string | null;
  readonly category: string | null;
  readonly mechanic: string | null;
  readonly license: string | null;
  readonly licenseAuthor: string | null;
  readonly licenseUrl: string | null;
  readonly reviewed: boolean;
  /** Relógio do servidor na última gravação; só informativo (quem ordena o pull é o servidor). */
  readonly updatedAt: number;
  /** Relógio do aparelho que escreveu: decide o conflito, o mais novo vence. */
  readonly clientUpdatedAt: number;
  /** Lápide: instante em que foi apagado, ou `null` se está vivo. A linha fica para o apagamento valer em todo aparelho. */
  readonly deletedAt: number | null;
}

/** Número anulável do gerador (`null | number | string`) para `number | null`; lixo vira `null`. */
export function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Texto de data da API para milissegundos. O .NET escreve até 7 casas de fração, e nem todo navegador aceita mais
 * de 3: corta para milissegundos antes de ler. Texto ilegível vira `null`.
 */
export function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Converte a resposta da API na linha local. Único lugar que lida com as particularidades do tipo gerado. */
export function toLocalExercise(dto: ExerciseDto): LocalExercise {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    slug: dto.slug,
    source: dto.source,
    sourceRef: dto.sourceRef,
    name: dto.name,
    nameKey: normalizeText(dto.name),
    instructions: dto.instructions,
    primaryMuscles: dto.primaryMuscles,
    secondaryMuscles: dto.secondaryMuscles,
    equipment: dto.equipment,
    recordType: dto.recordType,
    stepKg: toNumberOrNull(dto.stepKg),
    stepClientUpdatedAt: parseInstant(dto.stepClientUpdatedAt),
    level: dto.level,
    category: dto.category,
    mechanic: dto.mechanic,
    license: dto.license,
    licenseAuthor: dto.licenseAuthor,
    licenseUrl: dto.licenseUrl,
    reviewed: dto.reviewed,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

/**
 * Decide entre a linha local e a que veio do servidor. O conteúdo e o salto de carga têm relógios separados: o
 * dono pode mudar o salto de um exercício de catálogo em outro aparelho sem que o `clientUpdatedAt` do exercício
 * se mexa, então decidir pela linha inteira perderia essa escolha.
 *
 * - Conteúdo: vale o `clientUpdatedAt` mais novo; empate vale o servidor. Linha de catálogo (que o dono nunca
 *   edita) é sempre a do servidor, para a correção de texto da semente chegar mesmo que o relógio coincida.
 * - Salto: vale o `stepClientUpdatedAt` mais novo; quem nunca teve escolha (`null`) perde para quem teve; sem
 *   escolha nos dois lados, o salto acompanha o conteúdo.
 */
export function resolveExercise(local: LocalExercise, remote: LocalExercise): LocalExercise {
  const content =
    remote.source !== 'own' || remote.clientUpdatedAt >= local.clientUpdatedAt ? remote : local;
  const step = pickStepOwner(local, remote, content);

  if (content === step) return content;
  return { ...content, stepKg: step.stepKg, stepClientUpdatedAt: step.stepClientUpdatedAt };
}

function pickStepOwner(
  local: LocalExercise,
  remote: LocalExercise,
  content: LocalExercise,
): LocalExercise {
  const localAt = local.stepClientUpdatedAt;
  const remoteAt = remote.stepClientUpdatedAt;
  if (localAt === null && remoteAt === null) return content;
  if (localAt === null) return remote;
  if (remoteAt === null) return local;
  return remoteAt >= localAt ? remote : local;
}
