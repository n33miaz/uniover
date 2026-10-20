import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import {
  NEW_ITEM_DEFAULTS,
  ROUTINE_LIMITS,
  type RoutineItemModel,
  type RoutineModel,
} from '../../domain/routines/routine-model';
import {
  moveItem as moveItemInList,
  normalizeItems,
  toggleSupersetWithNext,
} from '../../domain/routines/supersets';
import { validateRoutine } from '../../domain/routines/validate-routine';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import {
  type LocalRoutine,
  type RoutineTemplate,
  resolveRoutine,
  toRoutineTemplates,
  toUpsertBody,
} from './routine';
import { RoutineApi, routinePath } from './routine-api';

/** Um item do que a tela entrega ao salvar; a ordem da lista é a ordem da rotina. Sem `id`, o item é novo. */
export interface RoutineDraftItem {
  readonly id?: string;
  readonly exerciseId: string;
  readonly targetSets: number;
  readonly repMin: number;
  readonly repMax: number;
  /** Descanso em segundos. */
  readonly restSeconds: number;
  /** Número do grupo de supersérie, ou `null`/ausente. Vira "sem supersérie" se ficar sozinho. */
  readonly supersetGroup?: number | null;
  readonly note?: string;
}

/**
 * O que a tela de editar rotina entrega. Sem `id`, cria; com o id de uma rotina viva, edita. Campo ausente mantém o que
 * a rotina já tinha (e, numa rotina nova, vale o padrão: ativa, no fim da sequência, sem anotação).
 */
export interface RoutineDraft {
  readonly id?: string;
  readonly name: string;
  readonly position?: number;
  readonly active?: boolean;
  readonly note?: string;
  readonly items: readonly RoutineDraftItem[];
}

/**
 * Resultado de uma escrita numa rotina. `storage-full`: o aparelho não tem espaço para guardar o pedido na fila, e
 * nada ficou gravado (a tela precisa avisar o usuário). `not-found`: a rotina (ou o item) não existe ou foi apagada.
 * `routine-full`: a rotina já tem o máximo de itens.
 */
export type RoutineWriteResult =
  | { readonly status: 'saved'; readonly routine: LocalRoutine }
  | { readonly status: 'storage-full' }
  | { readonly status: 'not-found' }
  | { readonly status: 'routine-full' };

/** Resultado de uma escrita que mexe em várias rotinas de uma vez (reordenar). Tudo ou nada. */
export type RoutinesWriteResult =
  | { readonly status: 'saved'; readonly routines: readonly LocalRoutine[] }
  | { readonly status: 'storage-full' };

/**
 * Resultado de criar rotinas a partir de um modelo pronto. `missing` diz quais exercícios do modelo não existem no
 * catálogo deste aparelho e ficaram de fora: nunca em silêncio. `no-exercises`: nenhum exercício do modelo foi
 * achado, então nada foi criado. `templates-unavailable`: nem a rede nem a cópia guardada entregaram os modelos.
 */
export type TemplateResult =
  | {
      readonly status: 'saved';
      readonly routines: readonly LocalRoutine[];
      readonly missing: readonly string[];
    }
  | { readonly status: 'no-exercises'; readonly missing: readonly string[] }
  | { readonly status: 'template-not-found' }
  | { readonly status: 'templates-unavailable' }
  | { readonly status: 'storage-full' };

interface PendingWrite {
  readonly written: LocalRoutine;
  readonly previous: LocalRoutine | undefined;
  readonly deleted: boolean;
}

const QUEUE_MODULE = 'training';
/** Chave, na tabela `meta`, da cópia dos modelos prontos (os modelos não mudam, e assim valem sem rede). */
const TEMPLATES_KEY = 'routineTemplates';

/**
 * Único ponto de acesso às rotinas. A tela lê daqui, sempre do banco local e sem rede, e nunca vê lápide: a rotina
 * apagada some das leituras, mas a linha continua guardada para o apagamento valer em todo aparelho.
 *
 * Escrever = gravar no banco local **e** enfileirar um `PUT` da rotina inteira (uma entrada por rotina escrita; ordem
 * e superséries seguem juntas). Se a fila recusar por falta de espaço, a gravação local é desfeita: nada fica pela
 * metade. Posições e superséries são normalizadas aqui com as mesmas funções puras do domínio, então a linha local é
 * igual ao que o servidor devolve.
 */
@Injectable()
export class RoutineRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly api = inject(RoutineApi);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a lista relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /** As rotinas vivas e ativas, na ordem da sequência. */
  async list(): Promise<LocalRoutine[]> {
    return (await this.listAll()).filter((row) => row.active);
  }

  /** As rotinas vivas, ativas ou não, na ordem da sequência (para a tela que gerencia as fichas). */
  async listAll(): Promise<LocalRoutine[]> {
    const rows = await this.db.routines.toArray();
    return rows.filter((row) => row.deletedAt === null).sort(byPosition);
  }

  /**
   * Todas as linhas, inclusive lápides e inativas, na ordem da sequência. É o que `nextRoutine` precisa: a rotina
   * apagada continua marcando o ponto de onde a sequência segue.
   */
  async all(): Promise<LocalRoutine[]> {
    return (await this.db.routines.toArray()).sort(byPosition);
  }

  /** A rotina viva, ou `undefined` se não existe ou foi apagada. */
  async get(id: string): Promise<LocalRoutine | undefined> {
    const row = await this.db.routines.get(id);
    return row !== undefined && row.deletedAt === null ? row : undefined;
  }

  /** Lê a linha como está, lápide inclusa (quem escreve precisa do estado anterior exato). */
  readRaw(id: string): Promise<LocalRoutine | undefined> {
    return this.db.routines.get(id);
  }

  /** Funde o que veio do servidor (ver `resolveRoutine`). Nunca apaga linha por ausência. */
  async applyRemote(remote: readonly LocalRoutine[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.routines, async () => {
      const found = await this.db.routines.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalRoutine>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveRoutine);
      if (writes.length > 0) await this.db.routines.bulkPut(writes);
    });
    this.touch();
  }

  /**
   * Cria ou edita uma rotina inteira (cabeçalho e itens). Entrada inválida lança `TypeError` (a tela valida antes com
   * `validateRoutine`).
   */
  async save(draft: RoutineDraft): Promise<RoutineWriteResult> {
    const previous = draft.id ? await this.readRaw(draft.id) : undefined;
    if (draft.id && (previous === undefined || previous.deletedAt !== null)) {
      return { status: 'not-found' };
    }

    const id = draft.id ?? uuidV7();
    const model: RoutineModel = {
      id,
      name: draft.name.trim(),
      position: draft.position ?? previous?.position ?? (await this.nextPosition()),
      active: draft.active ?? previous?.active ?? true,
      note: (draft.note ?? previous?.note ?? '').trim(),
      items: normalizeItems(
        draft.items.map((item, position) => ({
          id: item.id ?? uuidV7(),
          exerciseId: item.exerciseId,
          position,
          targetSets: item.targetSets,
          repMin: item.repMin,
          repMax: item.repMax,
          restSeconds: item.restSeconds,
          supersetGroup: item.supersetGroup ?? null,
          note: (item.note ?? '').trim(),
        })),
      ),
    };
    assertValid(model);

    const stamp = this.nextStamp(previous?.clientUpdatedAt);
    const written: LocalRoutine = {
      ...model,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    const saved = await this.commit([{ written, previous, deleted: false }]);
    return saved ? { status: 'saved', routine: written } : { status: 'storage-full' };
  }

  /** Apaga a rotina por lápide (o `PUT` leva `deleted: true`; nunca um `DELETE`). */
  async softDelete(id: string): Promise<RoutineWriteResult> {
    const previous = await this.readRaw(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const written: LocalRoutine = {
      ...previous,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: stamp,
    };
    const saved = await this.commit([{ written, previous, deleted: true }]);
    return saved ? { status: 'saved', routine: written } : { status: 'storage-full' };
  }

  /**
   * Muda a ordem da sequência: `orderedIds` é a ordem desejada. As rotinas vivas que não foram citadas ficam depois,
   * na ordem em que estavam. Só as que mudaram de posição são escritas (um `PUT` cada); tudo ou nada.
   */
  async reorder(orderedIds: readonly string[]): Promise<RoutinesWriteResult> {
    const alive = await this.listAll();
    const byId = new Map(alive.map((row) => [row.id, row]));
    const wanted = [...new Set(orderedIds)].filter((id) => byId.has(id));
    const order = [
      ...wanted.map((id) => byId.get(id)!),
      ...alive.filter((row) => !wanted.includes(row.id)),
    ];

    const writes: PendingWrite[] = [];
    order.forEach((previous, position) => {
      if (previous.position === position) return;
      const stamp = this.nextStamp(previous.clientUpdatedAt);
      writes.push({
        written: { ...previous, position, updatedAt: stamp, clientUpdatedAt: stamp },
        previous,
        deleted: false,
      });
    });
    if (writes.length === 0) return { status: 'saved', routines: [] };

    const saved = await this.commit(writes);
    return saved
      ? { status: 'saved', routines: writes.map((write) => write.written) }
      : { status: 'storage-full' };
  }

  /**
   * "Adicionar a um treino": põe o exercício no fim da rotina com a meta padrão (3 séries, 8 a 12 repetições, descanso
   * de 90 s), que o dono edita depois.
   */
  addExercise(routineId: string, exerciseId: string): Promise<RoutineWriteResult> {
    return this.changeItems(routineId, (items) => {
      if (items.length >= ROUTINE_LIMITS.maxItems) return 'routine-full';
      const item: RoutineItemModel = {
        id: uuidV7(),
        exerciseId,
        position: items.length,
        ...NEW_ITEM_DEFAULTS,
        supersetGroup: null,
        note: '',
      };
      return normalizeItems([...items, item]);
    });
  }

  /** Move um item para o índice `toIndex` (Subir e Descer são `índice - 1` e `índice + 1`). */
  moveItem(routineId: string, itemId: string, toIndex: number): Promise<RoutineWriteResult> {
    return this.changeItems(routineId, (items) =>
      items.some((item) => item.id === itemId) ? moveItemInList(items, itemId, toIndex) : 'missing',
    );
  }

  /** "Juntar com o próximo": liga ou desliga o item ao seguinte. No último item não muda nada (e nada é enviado). */
  toggleSuperset(routineId: string, itemId: string): Promise<RoutineWriteResult> {
    return this.changeItems(routineId, (items) => {
      const index = items.findIndex((item) => item.id === itemId);
      return index < 0 ? 'missing' : toggleSupersetWithNext(items, index);
    });
  }

  /**
   * Os modelos prontos. Vêm da API e ficam guardados no aparelho; sem rede vale a cópia guardada. Rejeita só quando
   * nem a rede nem a cópia entregam.
   */
  async templates(): Promise<RoutineTemplate[]> {
    try {
      const list = toRoutineTemplates(await this.api.templates());
      await this.db.meta.put({ key: TEMPLATES_KEY, value: list }).catch(() => undefined);
      return list;
    } catch (error) {
      const cached = await this.db.meta.get(TEMPLATES_KEY);
      if (Array.isArray(cached?.value)) return cached.value as RoutineTemplate[];
      throw error;
    }
  }

  /**
   * Cria as rotinas de um modelo pronto (ABC, ABCD, full body), no fim da sequência, com ids novos (UUID v7). Os
   * exercícios do modelo são achados pelo `slug` no catálogo **local**; os que não existem aqui ficam de fora e vêm
   * em `missing`. Cada rotina criada é um `PUT`; se a fila recusar por espaço, nenhuma fica.
   */
  async createFromTemplate(templateId: string): Promise<TemplateResult> {
    let templates: RoutineTemplate[];
    try {
      templates = await this.templates();
    } catch {
      return { status: 'templates-unavailable' };
    }
    const template = templates.find((candidate) => candidate.id === templateId);
    if (template === undefined) return { status: 'template-not-found' };

    const slugs = [
      ...new Set(template.routines.flatMap((day) => day.items.map((item) => item.exerciseSlug))),
    ];
    // O catálogo de origem vale mais que o importado quando os dois têm o mesmo slug; exercício próprio nunca entra.
    const rows = (await this.db.exercises.where('slug').anyOf(slugs).toArray())
      .filter((row) => row.source !== 'own' && row.deletedAt === null)
      .sort(
        (a, b) => Number(b.source === 'free_exercise_db') - Number(a.source === 'free_exercise_db'),
      );
    const idBySlug = new Map<string, string>();
    for (const row of rows) if (!idBySlug.has(row.slug)) idBySlug.set(row.slug, row.id);
    const missing = slugs.filter((slug) => !idBySlug.has(slug));

    const stamp = this.runtime.now();
    const base = await this.nextPosition();
    const writes: PendingWrite[] = [];
    for (const day of template.routines) {
      const found = day.items.filter((item) => idBySlug.has(item.exerciseSlug));
      if (found.length === 0) continue;
      const model: RoutineModel = {
        id: uuidV7(),
        name: day.name,
        position: base + writes.length,
        active: true,
        note: '',
        items: normalizeItems(
          found.map((item, position) => ({
            id: uuidV7(),
            exerciseId: idBySlug.get(item.exerciseSlug)!,
            position,
            targetSets: item.targetSets,
            repMin: item.repMin,
            repMax: item.repMax,
            restSeconds: item.restSeconds,
            supersetGroup: item.supersetGroup,
            note: '',
          })),
        ),
      };
      assertValid(model);
      writes.push({
        written: { ...model, updatedAt: stamp, clientUpdatedAt: stamp, deletedAt: null },
        previous: undefined,
        deleted: false,
      });
    }
    if (writes.length === 0) return { status: 'no-exercises', missing };

    const saved = await this.commit(writes);
    return saved
      ? { status: 'saved', routines: writes.map((write) => write.written), missing }
      : { status: 'storage-full' };
  }

  /** Aplica uma mudança só nos itens de uma rotina viva; sem mudança de fato, não grava nem envia nada. */
  private async changeItems(
    routineId: string,
    change: (
      items: readonly RoutineItemModel[],
    ) => readonly RoutineItemModel[] | 'missing' | 'routine-full',
  ): Promise<RoutineWriteResult> {
    const previous = await this.readRaw(routineId);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const items = change(previous.items);
    if (items === 'missing') return { status: 'not-found' };
    if (items === 'routine-full') return { status: 'routine-full' };
    if (JSON.stringify(items) === JSON.stringify(previous.items)) {
      return { status: 'saved', routine: previous };
    }

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const written: LocalRoutine = { ...previous, items, updatedAt: stamp, clientUpdatedAt: stamp };
    const saved = await this.commit([{ written, previous, deleted: false }]);
    return saved ? { status: 'saved', routine: written } : { status: 'storage-full' };
  }

  /** Instante da escrita: o relógio do aparelho, nunca menor ou igual ao da escrita anterior da mesma rotina. */
  private nextStamp(previous: number | undefined): number {
    return Math.max(this.runtime.now(), (previous ?? 0) + 1);
  }

  /** Posição da próxima rotina nova: depois da última das vivas. */
  private async nextPosition(): Promise<number> {
    const alive = await this.listAll();
    return alive.length === 0 ? 0 : Math.max(...alive.map((row) => row.position)) + 1;
  }

  /**
   * Grava no banco local e enfileira um `PUT` por rotina. `false` = a fila recusou por falta de espaço: o que já tinha
   * entrado na fila é descartado e as gravações locais são desfeitas. (Se o envio já tiver levado uma das primeiras
   * escritas ao servidor, o descarte não a alcança; o próximo puxar traz a rotina de volta, então nada se perde.)
   */
  private async commit(writes: readonly PendingWrite[]): Promise<boolean> {
    await this.db.routines.bulkPut(writes.map((write) => write.written));
    this.touch();

    const queued: string[] = [];
    try {
      for (const write of writes) {
        queued.push(
          await this.queue.enqueue({
            method: 'PUT',
            url: routinePath(write.written.id),
            body: toUpsertBody(write.written, write.deleted),
            module: QUEUE_MODULE,
          }),
        );
      }
      return true;
    } catch (error) {
      for (const key of queued) await this.queue.discard(key);
      await this.undoLocal(writes);
      if (error instanceof QueueStorageFullError) return false;
      throw error;
    }
  }

  /** Desfaz as gravações locais que a fila recusou; só mexe na linha se ela ainda é a que foi gravada. */
  private async undoLocal(writes: readonly PendingWrite[]): Promise<void> {
    await this.db.transaction('rw', this.db.routines, async () => {
      for (const { written, previous } of writes) {
        const current = await this.db.routines.get(written.id);
        if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt) continue;
        if (previous) await this.db.routines.put(previous);
        else await this.db.routines.delete(written.id);
      }
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}

function byPosition(a: LocalRoutine, b: LocalRoutine): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function assertValid(model: RoutineModel): void {
  const issues = validateRoutine(model);
  if (issues.length > 0) {
    throw new TypeError(
      `Rotina inválida: ${issues.map((issue) => `${issue.path} (${issue.code})`).join(', ')}.`,
    );
  }
}
