import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { SyncEngine } from '../../../../core/offline-queue/sync-engine';
import { TRAINING_DB } from '../training-db';
import { CURSOR_REWIND_MS, rewindCursor } from './cursor';
import { PullApi } from './pull-api';
import { DEFAULT_PULL_PAGE_SIZE, ResourceSync, TRAINING_RESOURCE_SYNCS } from './resource-sync';

/**
 * Por que o último puxar falhou, sem texto: a tela escolhe a mensagem ("usando o que está no aparelho desde
 * HH:MM"). `network`: sem resposta · `server`: 5xx, 408 ou 429 (servidor acordando ou ocupado) · `unexpected`:
 * qualquer outra coisa.
 */
export type TrainingSyncError = 'network' | 'server' | 'unexpected';

function classify(error: unknown): TrainingSyncError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'network';
    if (error.status >= 500 || error.status === 408 || error.status === 429) return 'server';
  }
  return 'unexpected';
}

/**
 * Puxador genérico do Treino: traz do servidor, por cursor, o que mudou em cada recurso registrado
 * (`ResourceSync`) e funde no banco local. A tela lê sempre do banco; isto só o mantém em dia.
 *
 * Regras:
 * - **só puxa com a fila de escrita vazia**: o que o aparelho escreveu sobe antes, para o servidor já ter visto
 *   tudo (hidratar e enviar antes de puxar);
 * - **uma passada por vez**, e pedido que chega no meio vira uma passada extra (nenhum se perde);
 * - gatilhos: a partida do módulo (`start()`), o evento `online`, a volta à aba, o fim de um envio da fila
 *   (`lastSyncAt` mudou) e o botão manual (`pullNow()`). **Nenhum temporizador**: o servidor dorme de graça e
 *   não é acordado à toa;
 * - falha de rede ou de servidor não é exceção: vira o sinal `error`, e o aparelho segue com o que tem;
 * - cada pass recua o cursor em 2 minutos na primeira página (`CURSOR_REWIND_MS`); reaplicar é idempotente.
 */
@Injectable()
export class TrainingSync {
  private readonly db = inject(TRAINING_DB);
  private readonly resources = inject(TRAINING_RESOURCE_SYNCS, { optional: true }) ?? [];
  private readonly api = inject(PullApi);
  private readonly queue = inject(OfflineQueue);
  private readonly engine = inject(SyncEngine);
  private readonly connectivity = inject(ConnectivityService);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly doc = inject(DOCUMENT);

  private readonly _pulling = signal(false);
  private readonly _lastPullAt = signal<number | null>(null);
  private readonly _error = signal<TrainingSyncError | null>(null);

  /** Há um puxar em andamento. */
  readonly pulling = this._pulling.asReadonly();
  /** Instante (ms) do último puxar completo, ou `null` se este aparelho ainda não puxou. */
  readonly lastPullAt = this._lastPullAt.asReadonly();
  /** Motivo da falha do último puxar; `null` quando deu certo (ou ainda não rodou). */
  readonly error = this._error.asReadonly();

  private starting: Promise<void> | null = null;
  private started = false;
  private running: Promise<void> | null = null;
  private requested = false;
  private seenSyncAt: number | null = null;

  constructor() {
    const win = this.doc.defaultView;
    const onOnline = () => void this.request();
    const onVisibility = () => {
      if (this.doc.visibilityState === 'visible') void this.request();
    };
    win?.addEventListener('online', onOnline);
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      win?.removeEventListener('online', onOnline);
      this.doc.removeEventListener('visibilitychange', onVisibility);
    });

    // Um envio da fila que terminou (o carimbo mudou) é motivo para puxar: se foi o último, a fila esvaziou.
    effect(() => {
      const syncedAt = this.queue.lastSyncAt();
      untracked(() => {
        if (syncedAt === this.seenSyncAt) return;
        this.seenSyncAt = syncedAt;
        void this.request();
      });
    });
  }

  /**
   * Chamado pela casca do módulo ao entrar. Lê quando foi o último puxar, espera a fila ser hidratada (sem isso
   * `pendingCount` mostra 0 mesmo com envio pendente) e faz a primeira passada. Idempotente.
   */
  start(): Promise<void> {
    this.starting ??= this.boot().catch((error: unknown) => {
      // Não deu para hidratar a fila: não puxa (a regra é fila vazia). Uma próxima chamada tenta de novo.
      this._error.set(classify(error));
      this.starting = null;
    });
    return this.starting;
  }

  /** Botão manual: sobe o que está na fila e puxa em seguida. Resolve quando a passada termina. */
  async pullNow(): Promise<void> {
    await this.start();
    await this.queue.syncNow();
    await this.request();
  }

  private async boot(): Promise<void> {
    this._lastPullAt.set(await this.readLastPullAt());
    await this.engine.start();
    this.seenSyncAt = this.queue.lastSyncAt();
    this.started = true;
    await this.request();
  }

  /** O instante mais antigo entre os recursos: o aparelho só está "em dia desde" quando todos estão. */
  private async readLastPullAt(): Promise<number | null> {
    if (this.resources.length === 0) return null;
    let oldest: number | null = null;
    for (const resource of this.resources) {
      const at = (await this.db.syncState.get(resource.resource))?.lastPullAt ?? null;
      if (at === null) return null;
      oldest = oldest === null ? at : Math.min(oldest, at);
    }
    return oldest;
  }

  /** Pede uma passada. Pedidos seguidos viram uma passada extra só; antes de `start()` não faz nada. */
  private request(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.requested = true;
    this.running ??= this.loop();
    return this.running;
  }

  private async loop(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        await this.pass();
      }
    } finally {
      // Dentro do `finally`, para nenhum pedido cair na fresta entre o fim do laço e a liberação.
      this.running = null;
    }
  }

  private async pass(): Promise<void> {
    // Sem rede não há o que tentar (o evento `online` volta aqui) e isso não é erro. Com envio pendente, a fila
    // sobe primeiro; o fim do envio chama de novo.
    if (this.resources.length === 0) return;
    if (!this.connectivity.online() || this.queue.pendingCount() > 0) return;

    this._pulling.set(true);
    try {
      for (const resource of this.resources) await this.pullResource(resource);
      this._error.set(null);
      this._lastPullAt.set(this.runtime.now());
    } catch (error) {
      this._error.set(classify(error));
    } finally {
      this._pulling.set(false);
    }
  }

  private async pullResource(resource: ResourceSync): Promise<void> {
    const name = resource.resource;
    const previous = await this.db.syncState.get(name);
    const limit = resource.pageSize ?? DEFAULT_PULL_PAGE_SIZE;

    let stored = previous?.cursor ?? null;
    // Só o primeiro pedido recua o cursor; as páginas seguintes seguem o cursor que o servidor devolveu.
    let after = stored === null ? null : rewindCursor(stored, CURSOR_REWIND_MS);

    for (;;) {
      const page = await this.api.fetchPage<unknown>(resource.path, after, limit);

      // Página vazia devolve o cursor que recebeu (recuado): guardá-lo faria o cursor andar para trás a cada puxar.
      if (page.items.length > 0) {
        await resource.merge(page.items);
        if (page.nextCursor !== null) {
          stored = page.nextCursor;
          // Guardado a cada página: um puxar interrompido continua de onde parou.
          await this.db.syncState.put({
            resource: name,
            cursor: stored,
            lastPullAt: previous?.lastPullAt ?? null,
          });
        }
      }

      // Acabou quando a página veio incompleta, vazia ou sem cursor novo (`nextCursor` nulo não quer dizer "fim":
      // o servidor devolve o último cursor mesmo na última página).
      if (page.items.length < limit || page.nextCursor === null || page.nextCursor === after) break;
      after = page.nextCursor;
    }

    await this.db.syncState.put({ resource: name, cursor: stored, lastPullAt: this.runtime.now() });
  }
}
