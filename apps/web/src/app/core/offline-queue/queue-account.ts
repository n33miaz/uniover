import { EnvironmentInjector, InjectionToken } from '@angular/core';
import type { OfflineDb } from './offline-db';
import type { OutboxStore } from './outbox-store';
import type { SyncEngine } from './sync-engine';

/** A conta dona da fila em que o motor e a loja estão (cada conta tem a sua, ver `QueueScopes`). */
export const QUEUE_ACCOUNT = new InjectionToken<string>('QUEUE_ACCOUNT');

/**
 * Resolve quando o banco da conta está pronto para uso: se era a vez dela de adotar o banco antigo (sem dono), a cópia já
 * foi feita e conferida. Nunca rejeita (uma adoção que falha recomeça na próxima partida, sem travar o app).
 */
export const QUEUE_READY = new InjectionToken<Promise<void>>('QUEUE_READY');

/**
 * Faz a fila (`OfflineQueue`) falar só com a fila desta conta, mesmo que o aparelho troque de conta enquanto quem a
 * pediu ainda trabalha. Quem grava no banco local de uma conta a recebe amarrada a ela: uma escrita de A que termina
 * depois de B entrar é recusada em vez de cair na fila de B (e sair com o token de B).
 */
export const QUEUE_BOUND_ACCOUNT = new InjectionToken<string>('QUEUE_BOUND_ACCOUNT');

/** A fila de uma conta: o banco dela, a loja sobre ele e o motor de envio, num injetor que morre com a troca de conta. */
export interface AccountQueue {
  readonly accountId: string;
  readonly injector: EnvironmentInjector;
  readonly db: OfflineDb;
  readonly store: OutboxStore;
  readonly engine: SyncEngine;
  readonly ready: Promise<void>;
}

/** A escrita não foi guardada porque a conta do aparelho já não é a de quem a pediu (ou não há conta). */
export class QueueAccountError extends Error {
  constructor() {
    super('A conta deste aparelho mudou: a escrita não foi guardada na fila.');
    this.name = 'QueueAccountError';
  }
}
