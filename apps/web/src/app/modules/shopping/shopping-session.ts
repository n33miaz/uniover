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

/**
 * De quanto em quanto tempo o feed é consultado logo depois de uma mudança (daqui ou de outra pessoa), com a tela de
 * Compras à vista e outra pessoa no grupo: é o atraso máximo para o que ela fez aparecer aqui enquanto as duas mexem na
 * lista. Fora disso (tela oculta, sem rede, grupo de uma pessoa só) não há consulta nenhuma.
 */
export const LIVE_INTERVAL_MS = 4000;
/** Por quanto tempo depois da última mudança a consulta segue a cada `LIVE_INTERVAL_MS`. */
export const LIVE_FAST_FOR_MS = 3 * 60_000;
/** O intervalo depois disso, enquanto a lista parece parada. */
export const LIVE_SLOW_INTERVAL_MS = 20_000;
/**
 * Sem mudança por este tempo, a consulta para até a pessoa tocar na tela, voltar à aba ou mudar algo: uma aba esquecida
 * aberta não mantém o servidor e o banco acordados o dia todo.
 */
export const LIVE_IDLE_AFTER_MS = 10 * 60_000;

/**
 * A consulta periódica. Ligada (`set`), chama `tick` a cada `LIVE_INTERVAL_MS` nos primeiros minutos depois da última
 * mudança (`changed`), depois a cada `LIVE_SLOW_INTERVAL_MS`, e para de vez passado `LIVE_IDLE_AFTER_MS`; `wake` a
 * retoma. Desligada, não deixa temporizador nenhum para trás.
 */
export class LiveWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private lastChange = Date.now();

  constructor(private readonly tick: () => void) {}

  /** Só há o que consultar com outra pessoa no grupo, a tela à vista e rede. */
  set(shared: boolean, visible: boolean, online: boolean): void {
    this.wanted = shared && visible && online;
    if (!this.wanted) this.clear();
    else if (this.timer === null) this.schedule();
  }

  /** Algo mudou na lista (aqui ou no feed): volta a consultar a cada `LIVE_INTERVAL_MS`. */
  changed(): void {
    this.lastChange = Date.now();
    if (!this.wanted) return;
    this.clear();
    this.schedule();
  }

  /** A pessoa está olhando (tocou na tela, voltou à aba): a consulta parada recomeça; a que segue fica como está. */
  wake(): void {
    if (this.wanted && this.timer === null) this.changed();
  }

  stop(): void {
    this.set(false, false, false);
  }

  private schedule(): void {
    const idle = Date.now() - this.lastChange;
    if (idle >= LIVE_IDLE_AFTER_MS) return;
    const delay = idle < LIVE_FAST_FOR_MS ? LIVE_INTERVAL_MS : LIVE_SLOW_INTERVAL_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      if (this.wanted) this.schedule();
    }, delay);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A conversa com a API: o lote de operações, o feed e o preço da última vez. */
export function httpShoppingTransport(http: HttpClient): ShoppingTransport {
  return {
    send: (operations: readonly PendingOperation[]) =>
      firstValueFrom(
        http.post<OperationResult[]>(`${BASE}/operations`, {
          // A hora do envio, no mesmo relógio de `at`: o servidor desconta a diferença entre os dois relógios, então um
          // aparelho com a hora errada não perde (nem ganha) a disputa entre dois preços.
          sentAt: new Date().toISOString(),
          operations: operations.map((operation) => ({
            operationId: operation.id,
            kind: operation.kind,
            id: operation.entityId,
            purchaseId: operation.purchaseId ?? null,
            body: operation.body,
            // Quando a pessoa fez a mudança: entre dois preços digitados sem sinal, o servidor fica com o mais recente.
            at: new Date(operation.createdAt).toISOString(),
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
 * tela reaparece e quando a sessão da conta se confirma. Com outra pessoa no grupo e a tela à vista, o feed também é
 * consultado de tempos em tempos (ver `LiveWatch`), para as duas verem a mesma lista ao mesmo tempo. Vive com a tela (é
 * dela que vem a instância): fora de Compras nada é lido nem enviado.
 */
@Injectable()
export class ShoppingSession {
  private readonly http = inject(HttpClient);
  private readonly account = inject(AccountScope);
  private readonly openDb = inject(SHOPPING_DB_FACTORY);
  private accountId: string | null = null;
  private readonly live = new LiveWatch(() => void this.store()?.sync());

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
    // Outra pessoa entrou no grupo (ou a última saiu): a consulta periódica liga ou desliga.
    effect(() => {
      const shared = this.store()?.shared() ?? false;
      untracked(() => this.watch(shared));
    });
    // Cada mudança vista (escrita daqui, novidade no feed) mantém a consulta no ritmo rápido, ou a retoma se parou.
    effect(() => {
      this.store()?.activity();
      untracked(() => this.live.changed());
    });
    const sync = (): void => void this.store()?.sync();
    const watch = (): void => this.watch(this.store()?.shared() ?? false);
    const touched = (): void => this.live.wake();
    const online = (): void => {
      sync();
      watch();
    };
    const visible = (): void => {
      if (document.visibilityState === 'visible') sync();
      watch();
      if (document.visibilityState === 'visible') this.live.wake();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', watch);
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('pointerdown', touched, { passive: true });
    document.addEventListener('keydown', touched);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', watch);
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('pointerdown', touched);
      document.removeEventListener('keydown', touched);
      this.live.stop();
      this.accountId = null;
      this.store()?.close();
    });
  }

  /** Liga a consulta periódica só enquanto ela serve a alguém: grupo com mais gente, tela à vista e rede. */
  private watch(shared: boolean): void {
    this.live.set(
      shared,
      document.visibilityState === 'visible',
      typeof navigator === 'undefined' || navigator.onLine,
    );
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
