import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject } from '@angular/core';
import { AccountScope } from '../session/account-scope';
import { OutboxItem, OutboxMethod } from './offline-db';
import { AccountQueue, QUEUE_BOUND_ACCOUNT, QueueAccountError } from './queue-account';
import { QueueScopes } from './queue-scopes';

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
 *
 * A fila é da conta em uso no aparelho (cada conta tem a sua, ver `QueueScopes`): contadores, itens e envio são sempre os
 * dela. Quem grava num banco local de conta recebe esta fachada AMARRADA a essa conta (`QUEUE_BOUND_ACCOUNT`): se o
 * aparelho trocar de conta antes de a escrita chegar à fila, ela é recusada com `QueueAccountError` em vez de cair na fila
 * da outra conta.
 */
@Injectable({ providedIn: 'root' })
export class OfflineQueue {
  private readonly scopes = inject(QueueScopes);
  private readonly account = inject(AccountScope);
  private readonly nav = inject(DOCUMENT).defaultView?.navigator;
  private readonly bound = inject(QUEUE_BOUND_ACCOUNT, { optional: true });

  /** A fila a que esta fachada serve agora: a da conta em uso e, se amarrada, só se for a conta a que foi amarrada. */
  private readonly target = computed<AccountQueue | null>(() => {
    const active = this.scopes.active();
    return active && (this.bound === null || active.accountId === this.bound) ? active : null;
  });

  /** Quantos ainda não foram sincronizados (esperando ou em voo). */
  readonly pendingCount = computed(() => this.target()?.store.pendingCount() ?? 0);
  /** Quantos o servidor recusou de vez e esperam decisão do usuário. */
  readonly failedCount = computed(() => this.target()?.store.failedCount() ?? 0);
  /** Instante (ms) do último envio aceito. */
  readonly lastSyncAt = computed(() => this.target()?.store.lastSyncAt() ?? null);
  /** Esta aba está enviando agora. */
  readonly syncing = computed(() => this.target()?.engine.syncing() ?? false);

  /** A conta desta fachada: a amarrada ou, sem amarra, a que está em uso no aparelho (`null` se não se sabe). */
  get accountId(): string | null {
    return this.bound ?? this.account.id();
  }

  /**
   * Abre a fila da conta e liga o motor de envio (hidrata os contadores e reenvia o que ficou pendente de antes). Idempotente;
   * sem conta conhecida não faz nada.
   */
  async start(): Promise<void> {
    const queue = this.current();
    if (queue) await queue.engine.start();
  }

  /**
   * Guarda a escrita no IndexedDB e só então resolve com a chave de idempotência do item. Rejeita apenas se o
   * pedido for inválido, se o aparelho não tiver espaço (`QueueStorageFullError`) ou se a conta do aparelho já não for a
   * de quem pergunta (`QueueAccountError`): nada foi guardado e quem chama precisa dizer isso ao usuário. Nunca lança por
   * estar offline.
   */
  async enqueue(request: EnqueueRequest): Promise<string> {
    if (!METHODS.includes(request.method)) {
      throw new TypeError(`Método não aceito pela fila: ${request.method}`);
    }
    if (!request.url.startsWith('/api/') || request.url.startsWith('//')) {
      throw new TypeError('A fila só aceita caminhos relativos da API (começando por /api/).');
    }

    const queue = this.current();
    if (!queue) throw new QueueAccountError();
    await queue.ready;
    const item = await queue.store.add(request);
    void this.requestPersistence(queue);
    void queue.engine.start().then(() => queue.engine.drain());
    return item.id;
  }

  /** Botão "sincronizar agora": tenta já, sem esperar o backoff. */
  async syncNow(): Promise<void> {
    const queue = this.current();
    if (!queue) return;
    await queue.engine.start();
    await queue.engine.drain({ force: true });
  }

  /** Todos os itens ainda no aparelho, desta conta (para a tela que revisa o que falhou). */
  async items(): Promise<OutboxItem[]> {
    const queue = this.current();
    if (!queue) return [];
    await queue.ready;
    return queue.store.list();
  }

  /** Edita o corpo de um item que ainda não chegou ao servidor. */
  async update(id: string, body: unknown): Promise<boolean> {
    const queue = this.current();
    if (!queue) return false;
    const updated = await queue.store.update(id, { body });
    if (updated) void queue.engine.drain();
    return updated !== undefined;
  }

  /** Reenvia um item que o servidor recusou. */
  async retry(id: string): Promise<boolean> {
    const queue = this.current();
    if (!queue) return false;
    const updated = await queue.store.retry(id);
    if (updated) void queue.engine.drain({ force: true });
    return updated !== undefined;
  }

  /** Descarta um item. Só o usuário decide isto: nenhum erro, 401 ou logout chama este método. */
  async discard(id: string): Promise<boolean> {
    const queue = this.current();
    return queue ? queue.store.discard(id) : false;
  }

  /** A fila da conta em uso, já alinhada com a conta atual; `null` se não há conta ou se esta fachada é de outra. */
  private current(): AccountQueue | null {
    const active = this.scopes.sync();
    return active && (this.bound === null || active.accountId === this.bound) ? active : null;
  }

  /**
   * Pede ao navegador que não apague o IndexedDB por falta de uso (o iOS limpa dados de sites após 7 dias sem
   * abrir). Uma vez só por conta, lembrado no banco dela; um erro aqui nunca atrapalha a gravação.
   */
  private async requestPersistence(queue: AccountQueue): Promise<void> {
    try {
      if (!(await queue.store.claimPersistRequest())) return;
      await this.nav?.storage?.persist?.();
    } catch {
      // melhor esforço: sem permissão ou sem a API, a fila funciona do mesmo jeito
    }
  }
}
