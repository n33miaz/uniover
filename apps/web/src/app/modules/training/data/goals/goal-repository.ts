import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import {
  type GoalIssue,
  type GoalKind,
  goalKey,
  validateGoal,
} from '../../domain/progress/goal-model';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import { type LocalGoal, resolveGoal, toGoalBody } from './goal';
import { goalPath } from './goal-api';

/**
 * Resultado de uma escrita de meta. `invalid`: a meta não passa nos limites (`issues` diz o campo). `not-found`: não há
 * meta viva para remover. `storage-full`: o aparelho não tem espaço para guardar o pedido, e nada ficou gravado.
 */
export type GoalWriteResult =
  | { readonly status: 'saved'; readonly goal: LocalGoal }
  | { readonly status: 'invalid'; readonly issues: readonly GoalIssue[] }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

const QUEUE_MODULE = 'training';

/**
 * Único ponto de acesso às metas. A tela lê daqui, sempre do banco local e sem rede, e nunca vê lápide.
 *
 * Escrever = gravar no banco local **e** enfileirar um `PUT` pela chave natural (tipo e exercício). Se a fila recusar por
 * falta de espaço, a gravação local é desfeita: nada fica pela metade. Remover é um `PUT` com valor vazio (lápide), nunca
 * um `DELETE`. A meta é do dono: o app não sugere valor.
 */
@Injectable()
export class GoalRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a tela relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /** As metas vivas, pela ordem do tipo e do exercício. */
  async list(): Promise<LocalGoal[]> {
    const rows = await this.db.goals.toArray();
    return rows.filter((row) => row.deletedAt === null).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** A meta viva do tipo (e do exercício, na meta de 1RM), ou `undefined`. */
  async get(kind: GoalKind, exerciseId: string | null = null): Promise<LocalGoal | undefined> {
    const row = await this.db.goals.get(goalKey(kind, exerciseId));
    return row !== undefined && row.deletedAt === null ? row : undefined;
  }

  /** O valor da meta viva, ou `null` se o dono não definiu nenhuma. */
  async value(kind: GoalKind, exerciseId: string | null = null): Promise<number | null> {
    return (await this.get(kind, exerciseId))?.value ?? null;
  }

  /** Define (ou troca) a meta. */
  async set(
    kind: GoalKind,
    value: number,
    exerciseId: string | null = null,
  ): Promise<GoalWriteResult> {
    const issues = validateGoal(kind, value, exerciseId);
    if (issues.length > 0) return { status: 'invalid', issues };

    const previous = await this.db.goals.get(goalKey(kind, exerciseId));
    const stamp = this.nextStamp(previous?.clientUpdatedAt);
    const written: LocalGoal = {
      id: goalKey(kind, exerciseId),
      kind,
      exerciseId,
      value,
      serverId: previous?.serverId ?? null,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    return this.commit(written, previous);
  }

  /** Remove a meta por lápide (o `PUT` leva o valor vazio). */
  async clear(kind: GoalKind, exerciseId: string | null = null): Promise<GoalWriteResult> {
    const previous = await this.db.goals.get(goalKey(kind, exerciseId));
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const written: LocalGoal = {
      ...previous,
      value: null,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: stamp,
    };
    return this.commit(written, previous);
  }

  /** Funde metas que vieram do servidor. Nunca apaga linha por ausência; a lápide chega como linha. */
  async applyRemote(remote: readonly LocalGoal[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.goals, async () => {
      const found = await this.db.goals.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalGoal>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveGoal);
      if (writes.length > 0) await this.db.goals.bulkPut(writes);
    });
    this.touch();
  }

  /** Instante da escrita: o relógio do aparelho, nunca menor ou igual ao da escrita anterior da mesma meta. */
  private nextStamp(previous: number | undefined): number {
    return Math.max(this.runtime.now(), (previous ?? 0) + 1);
  }

  /** Grava no banco local e enfileira o `PUT`; se a fila recusar por falta de espaço, desfaz a gravação local. */
  private async commit(
    written: LocalGoal,
    previous: LocalGoal | undefined,
  ): Promise<GoalWriteResult> {
    await this.db.goals.put(written);
    this.touch();
    try {
      await this.queue.enqueue({
        method: 'PUT',
        module: QUEUE_MODULE,
        url: goalPath(written.kind),
        body: toGoalBody(written),
      });
      return { status: 'saved', goal: written };
    } catch (error) {
      await this.undo(written, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  /** Desfaz a gravação local que a fila recusou; só mexe na linha se ela ainda é a que foi gravada. */
  private async undo(written: LocalGoal, previous: LocalGoal | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.goals, async () => {
      const current = await this.db.goals.get(written.id);
      if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt) return;
      if (previous) await this.db.goals.put(previous);
      else await this.db.goals.delete(written.id);
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
