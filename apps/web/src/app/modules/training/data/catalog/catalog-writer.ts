import { Injectable, inject } from '@angular/core';
import type { components } from '../../../../core/api/generated/schema';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { normalizeText } from '../../domain/text-search';
import { exercisePath, exerciseStepPath } from './catalog-api';
import { CatalogRepository } from './catalog-repository';
import type { LocalExercise } from './exercise';

/** O que a tela de "criar exercício" entrega. Sem `id`, cria; com o id de um exercício próprio, edita. */
export interface CustomExerciseDraft {
  readonly id?: string;
  readonly name: string;
  /** De 1 a 3 ids de músculo. */
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles?: readonly string[];
  readonly equipment: string;
  readonly recordType: string;
  /** Salto de carga próprio; `null` ou ausente vale o do equipamento. */
  readonly stepKg?: number | null;
  readonly instructions?: readonly string[];
}

/**
 * Resultado de uma escrita. `storage-full`: o aparelho não tem espaço para guardar o pedido na fila, e nada ficou
 * gravado (a tela precisa avisar o usuário). `not-found`: o exercício não existe ou já foi apagado.
 * `catalog-readonly`: exercício de catálogo não se edita nem se apaga (vira cópia própria).
 */
export type WriteResult =
  | { readonly status: 'saved'; readonly exercise: LocalExercise }
  | { readonly status: 'storage-full' }
  | { readonly status: 'not-found' }
  | { readonly status: 'catalog-readonly' };

type UpsertBody = components['schemas']['UpsertCustomExerciseRequest'];
type StepBody = components['schemas']['SetExerciseStepRequest'];

const QUEUE_MODULE = 'training';
const MAX_NAME = 120;
const MAX_PRIMARY_MUSCLES = 3;
const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_LENGTH = 500;

/**
 * Escritas do catálogo: grava no banco local **e** enfileira o `PUT` (a tela nunca espera a rede). Se a fila
 * recusar por falta de espaço, a gravação local é desfeita: nada fica pela metade. Apagar é um `PUT` com
 * `deleted: true` (lápide), nunca `DELETE`.
 */
@Injectable()
export class CatalogWriter {
  private readonly repository = inject(CatalogRepository);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);

  /** Cria ou edita um exercício próprio. Entrada inválida lança `TypeError` (a tela valida antes). */
  async saveCustomExercise(draft: CustomExerciseDraft): Promise<WriteResult> {
    const fields = validate(draft);
    const id = draft.id ?? uuidV7();
    const previous = draft.id ? await this.repository.readRaw(id) : undefined;
    if (draft.id && (previous === undefined || previous.deletedAt !== null)) {
      return { status: 'not-found' };
    }
    if (previous && previous.source !== 'own') return { status: 'catalog-readonly' };

    const stamp = this.nextStamp(previous?.clientUpdatedAt);
    // Com escolha de salto do dono já registrada ela continua valendo (o servidor também a prefere ao salto do
    // corpo do exercício); sem ela, o salto é o do rascunho.
    const keepChoice = previous !== undefined && previous.stepClientUpdatedAt !== null;
    const stepKg = keepChoice
      ? previous.stepKg
      : draft.stepKg !== undefined
        ? draft.stepKg
        : (previous?.stepKg ?? null);

    const written: LocalExercise = {
      id,
      slug: `${normalizeText(fields.name).replace(/ /g, '-')}-${id.slice(-8)}`,
      source: 'own',
      sourceRef: null,
      name: fields.name,
      nameKey: normalizeText(fields.name),
      instructions: fields.instructions,
      primaryMuscles: fields.primaryMuscles,
      secondaryMuscles: fields.secondaryMuscles,
      equipment: draft.equipment,
      recordType: draft.recordType,
      stepKg,
      stepClientUpdatedAt: previous?.stepClientUpdatedAt ?? null,
      level: null,
      category: null,
      mechanic: null,
      license: null,
      licenseAuthor: null,
      licenseUrl: null,
      reviewed: true,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    return this.commit(written, previous, () =>
      this.queue.enqueue({
        method: 'PUT',
        url: exercisePath(id),
        body: upsertBody(written, false),
        module: QUEUE_MODULE,
      }),
    );
  }

  /** Apaga um exercício próprio por lápide. */
  async deleteCustomExercise(id: string): Promise<WriteResult> {
    const previous = await this.repository.readRaw(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };
    if (previous.source !== 'own') return { status: 'catalog-readonly' };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const written: LocalExercise = {
      ...previous,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: stamp,
    };
    return this.commit(written, previous, () =>
      this.queue.enqueue({
        method: 'PUT',
        url: exercisePath(id),
        body: upsertBody(written, true),
        module: QUEUE_MODULE,
      }),
    );
  }

  /**
   * Ajusta o salto de carga de qualquer exercício (catálogo ou próprio). `null` devolve o salto ao do equipamento.
   * O relógio da escolha é separado do relógio do exercício, como no servidor.
   */
  async setStepKg(id: string, stepKg: number | null): Promise<WriteResult> {
    if (stepKg !== null && (!Number.isFinite(stepKg) || stepKg < 0)) {
      throw new TypeError('O salto de carga precisa ser um número maior ou igual a zero.');
    }
    const previous = await this.repository.readRaw(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const stamp = this.nextStamp(previous.stepClientUpdatedAt ?? undefined);
    const written: LocalExercise = { ...previous, stepKg, stepClientUpdatedAt: stamp };
    const body: StepBody = { stepKg, clientUpdatedAt: new Date(stamp).toISOString() };
    return this.commit(written, previous, () =>
      this.queue.enqueue({
        method: 'PUT',
        url: exerciseStepPath(id),
        body,
        module: QUEUE_MODULE,
      }),
    );
  }

  /** Instante da escrita: o relógio do aparelho, nunca menor ou igual ao da escrita anterior do mesmo registro. */
  private nextStamp(previous: number | undefined): number {
    return Math.max(this.runtime.now(), (previous ?? 0) + 1);
  }

  private async commit(
    written: LocalExercise,
    previous: LocalExercise | undefined,
    send: () => Promise<unknown>,
  ): Promise<WriteResult> {
    await this.repository.writeLocal(written);
    try {
      await send();
      return { status: 'saved', exercise: written };
    } catch (error) {
      // O pedido não ficou na fila: a gravação local não pode ficar sozinha, senão o aparelho mostraria um
      // exercício que nunca vai subir.
      await this.repository.undoLocal(written, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }
}

interface ValidFields {
  readonly name: string;
  readonly primaryMuscles: string[];
  readonly secondaryMuscles: string[];
  readonly instructions: string[];
}

/** Os mesmos limites do servidor: o que ele recusaria não deve nem entrar na fila. */
function validate(draft: CustomExerciseDraft): ValidFields {
  const name = draft.name.trim();
  if (name === '' || name.length > MAX_NAME) {
    throw new TypeError(`O nome precisa ter de 1 a ${MAX_NAME} caracteres.`);
  }
  const primaryMuscles = unique(draft.primaryMuscles);
  if (primaryMuscles.length < 1 || primaryMuscles.length > MAX_PRIMARY_MUSCLES) {
    throw new TypeError(`Informe de 1 a ${MAX_PRIMARY_MUSCLES} músculos principais.`);
  }
  const instructions = (draft.instructions ?? []).map((step) => step.trim()).filter(Boolean);
  if (
    instructions.length > MAX_INSTRUCTIONS ||
    instructions.some((step) => step.length > MAX_INSTRUCTION_LENGTH)
  ) {
    throw new TypeError(
      `As instruções aceitam até ${MAX_INSTRUCTIONS} passos de ${MAX_INSTRUCTION_LENGTH} caracteres.`,
    );
  }
  return {
    name,
    primaryMuscles,
    secondaryMuscles: unique(draft.secondaryMuscles ?? []),
    instructions,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function upsertBody(row: LocalExercise, deleted: boolean): UpsertBody {
  return {
    name: row.name,
    primaryMuscles: [...row.primaryMuscles],
    secondaryMuscles: [...row.secondaryMuscles],
    equipment: row.equipment,
    recordType: row.recordType,
    stepKg: row.stepKg,
    instructions: [...row.instructions],
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted,
  };
}
