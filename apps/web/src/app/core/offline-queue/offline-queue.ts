import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { OutboxItem, OutboxMethod } from './offline-db';
import { OutboxStore } from './outbox-store';
import { SyncEngine } from './sync-engine';

export interface EnqueueRequest {
  readonly method: OutboxMethod;
  /** Caminho relativo da API, começando por `/api/`. */
  readonly url: string;
  /** Corpo JSON (dado do usuário, nunca credencial). */
  readonly body?: unknown;
  /** Módulo que está gravando (organização e exibição). */
  readonly module: string;
}

const METHODS: readonly OutboxMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Fila de escrita offline, genérica: o módulo que escreve só chama `enqueue`. A promessa significa "guardado no
 * aparelho", nunca "enviado"; estar sem rede não é erro. O reenvio é do `SyncEngine`.
 */
@Injectable({ providedIn: 'root' })
export class OfflineQueue {
  private readonly store = inject(OutboxStore);
  private readonly engine = inject(SyncEngine);
  private readonly nav = inject(DOCUMENT).defaultView?.navigator;

  /** Quantos ainda não foram sincronizados (esperando ou em voo). */
  readonly pendingCount = this.store.pendingCount;
  /** Quantos o servidor recusou de vez e esperam decisão do usuário. */
  readonly failedCount = this.store.failedCount;
  /** Instante (ms) do último envio aceito. */
  readonly lastSyncAt = this.store.lastSyncAt;
  /** Esta aba está enviando agora. */
  readonly syncing = this.engine.syncing;

  /**
   * Guarda a escrita no IndexedDB e só então resolve com a chave de idempotência do item. Rejeita apenas se o
   * pedido for inválido ou se o aparelho não tiver espaço (`QueueStorageFullError`): nada foi guardado e quem
   * chama precisa dizer isso ao usuário. Nunca lança por estar offline.
   */
  async enqueue(request: EnqueueRequest): Promise<string> {
    if (!METHODS.includes(request.method)) {
      throw new TypeError(`Método não aceito pela fila: ${request.method}`);
    }
    if (!request.url.startsWith('/api/') || request.url.startsWith('//')) {
      throw new TypeError('A fila só aceita caminhos relativos da API (começando por /api/).');
    }

    const item = await this.store.add(request);
    void this.requestPersistence();
    void this.engine.start().then(() => this.engine.drain());
    return item.id;
  }

  /** Botão "sincronizar agora": tenta já, sem esperar o backoff. */
  async syncNow(): Promise<void> {
    await this.engine.start();
    await this.engine.drain({ force: true });
  }

  /** Todos os itens ainda no aparelho (para a tela que revisa o que falhou). */
  items(): Promise<OutboxItem[]> {
    return this.store.list();
  }

  /** Edita o corpo de um item que ainda não chegou ao servidor. */
  async update(id: string, body: unknown): Promise<boolean> {
    const updated = await this.store.update(id, { body });
    if (updated) void this.engine.drain();
    return updated !== undefined;
  }

  /** Reenvia um item que o servidor recusou. */
  async retry(id: string): Promise<boolean> {
    const updated = await this.store.retry(id);
    if (updated) void this.engine.drain({ force: true });
    return updated !== undefined;
  }

  /** Descarta um item. Só o usuário decide isto: nenhum erro, 401 ou logout chama este método. */
  discard(id: string): Promise<boolean> {
    return this.store.discard(id);
  }

  /**
   * Pede ao navegador que não apague o IndexedDB por falta de uso (o iOS limpa dados de sites após 7 dias sem
   * abrir). Uma vez só, lembrado no próprio banco; um erro aqui nunca atrapalha a gravação.
   */
  private async requestPersistence(): Promise<void> {
    try {
      if (!(await this.store.claimPersistRequest())) return;
      await this.nav?.storage?.persist?.();
    } catch {
      // melhor esforço: sem permissão ou sem a API, a fila funciona do mesmo jeito
    }
  }
}
