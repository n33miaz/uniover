import { InjectionToken } from '@angular/core';

/**
 * Relógio, temporizadores e sorte do motor da fila numa porta só: o teste troca por um relógio falso que anda
 * quando manda, sem congelar o IndexedDB (que usa os temporizadores reais do navegador).
 */
export interface QueueRuntime {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Número em [0, 1) para o jitter do backoff. */
  random(): number;
}

export const QUEUE_RUNTIME = new InjectionToken<QueueRuntime>('QUEUE_RUNTIME', {
  providedIn: 'root',
  factory: () => ({
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    random: () => Math.random(),
  }),
});

/** `ran: false` quando outra aba já segura o bloqueio (ela está enviando; esta aba não precisa). */
export type LockResult<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/** Exclusão entre abas: só uma aba envia por vez. */
export interface QueueLocks {
  tryRun<T>(name: string, task: () => Promise<T>): Promise<LockResult<T>>;
}

/** Nome do bloqueio entre abas do motor de envio. */
export const SYNC_LOCK_NAME = 'uniover-sync';

/**
 * `navigator.locks` com `ifAvailable`; sem a API, devolve que rodou e deixa o motor garantir uma execução por
 * aba (um *singleton* por aba, que é o que sobra nesses navegadores).
 */
export function browserQueueLocks(nav: Navigator | undefined): QueueLocks {
  return {
    async tryRun<T>(name: string, task: () => Promise<T>): Promise<LockResult<T>> {
      const locks = nav?.locks;
      if (!locks) return { ran: true, value: await task() };
      return locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) return { ran: false } as const;
        return { ran: true, value: await task() } as const;
      });
    },
  };
}

export const QUEUE_LOCKS = new InjectionToken<QueueLocks>('QUEUE_LOCKS', {
  providedIn: 'root',
  factory: () => browserQueueLocks(typeof navigator === 'undefined' ? undefined : navigator),
});

/**
 * Bloqueio entre abas da fila de UMA conta: só uma aba envia a fila dela por vez, e contas diferentes não se esperam
 * (a fila de cada uma é outro banco).
 */
export function syncLockName(accountId: string): string {
  return `${SYNC_LOCK_NAME}-${accountId}`;
}
