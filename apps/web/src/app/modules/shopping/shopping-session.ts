import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../core/config/app-config';
import { uuidV7 } from '../../core/offline-queue/uuid-v7';
import { AccountScope } from '../../core/session/account-scope';
import { SHOPPING_DB_FACTORY } from './shopping-db';
import type { PendingOperation } from './shopping-model';
import {
  ShoppingStore,
  type ChangesPage,
  type OperationResult,
  type ShoppingTransport,
} from './shopping-store';

const BASE = `${APP_CONFIG.apiBase}/v1/shopping`;

/** A conversa com a API: o lote de operações, o feed e o preço da última vez. */
export function httpShoppingTransport(http: HttpClient): ShoppingTransport {
  return {
    send: (operations: readonly PendingOperation[]) =>
      firstValueFrom(
        http.post<OperationResult[]>(`${BASE}/operations`, {
          operations: operations.map((operation) => ({
            operationId: operation.id,
            kind: operation.kind,
            id: operation.entityId,
            purchaseId: operation.purchaseId ?? null,
            body: operation.body,
          })),
        }),
      ),
    changes: (after: number) =>
      firstValueFrom(http.get<ChangesPage>(`${BASE}/changes`, { params: { after } })),
    lastPrice: async (productId: string) => {
      const found = await firstValueFrom(
        http.get<{ unitPrice: number } | null>(`${BASE}/products/${productId}/last-price`),
      );
      return found?.unitPrice ?? null;
    },
  };
}

/**
 * Compras da conta em uso. Abre o banco da conta (um por conta), lê o que ficou no aparelho e tenta sincronizar; se a
 * conta muda, a anterior sai de cena sem perder a fila dela. As tentativas seguintes saem quando a rede volta, quando a
 * tela reaparece e quando a sessão da conta se confirma. Não há temporizador. Vive com a tela (é dela que vem a
 * instância): fora de Compras nada é lido nem enviado.
 */
@Injectable()
export class ShoppingSession {
  private readonly http = inject(HttpClient);
  private readonly account = inject(AccountScope);
  private readonly openDb = inject(SHOPPING_DB_FACTORY);
  private accountId: string | null = null;

  /** As Compras da conta em uso, ou `null` enquanto a conta não é conhecida ou o banco dela não foi lido. */
  readonly store = signal<ShoppingStore | null>(null);

  constructor() {
    effect(() => {
      const id = this.account.id();
      untracked(() => void this.use(id));
    });
    // A sessão confirmada (o `/me` chegou, o token renovou) libera o envio do que esperava por ela.
    effect(() => {
      this.account.sessionAccount();
      untracked(() => void this.store()?.sync());
    });
    const sync = (): void => void this.store()?.sync();
    const visible = (): void => {
      if (document.visibilityState === 'visible') sync();
    };
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', visible);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', sync);
      document.removeEventListener('visibilitychange', visible);
      this.accountId = null;
      this.store()?.close();
    });
  }

  private async use(accountId: string | null): Promise<void> {
    if (accountId === this.accountId) return;
    this.accountId = accountId;
    this.store()?.close();
    this.store.set(null);
    if (accountId === null) return;

    const store = new ShoppingStore(this.openDb(accountId), httpShoppingTransport(this.http), {
      online: () => typeof navigator === 'undefined' || navigator.onLine,
      canSend: () => this.account.isSessionOf(accountId),
      now: () => Date.now(),
      newId: uuidV7,
    });
    try {
      await store.load();
    } catch {
      // Sem armazenamento no aparelho (modo privado): a tela fica na espera em vez de mostrar uma lista que não guarda.
      store.close();
      return;
    }
    if (this.accountId !== accountId) {
      store.close();
      return;
    }
    this.store.set(store);
    void store.sync();
  }
}
