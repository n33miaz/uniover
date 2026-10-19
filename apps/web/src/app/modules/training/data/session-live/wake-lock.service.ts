import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** O mínimo que se usa do `WakeLockSentinel` e do `navigator.wakeLock`. */
interface SentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<SentinelLike>;
}

/**
 * Tela acesa durante o treino (Wake Lock). É melhor esforço: no iPhone só funciona em PWA instalada a partir do iOS 18.4,
 * e a bateria baixa, a falta de permissão ou o sistema podem recusar. **Nenhum erro aqui quebra o treino**: `request()`
 * devolve `false` e o sinal `active` diz a verdade.
 *
 * O navegador solta o bloqueio sozinho quando a página some (aba trocada, tela bloqueada); por isso, enquanto o dono
 * quer a tela acesa, o bloqueio é pedido de novo na volta para a página visível.
 */
@Injectable()
export class WakeLockService {
  private readonly doc = inject(DOCUMENT);
  private readonly lock = (
    this.doc.defaultView?.navigator as { wakeLock?: WakeLockLike } | undefined
  )?.wakeLock;

  private readonly _supported = signal(this.lock !== undefined);
  private readonly _active = signal(false);
  private wanted = false;
  private sentinel: SentinelLike | null = null;
  private acquiring: Promise<boolean> | null = null;

  /** O navegador tem a API de tela acesa. */
  readonly supported = this._supported.asReadonly();
  /** Há um bloqueio de tela ativo agora. */
  readonly active = this._active.asReadonly();

  constructor() {
    const onVisibility = () => {
      if (this.doc.visibilityState === 'visible' && this.wanted && !this._active()) {
        void this.acquire();
      }
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() =>
      this.doc.removeEventListener('visibilitychange', onVisibility),
    );
  }

  /** Pede a tela acesa (ao iniciar o treino). `true` se o bloqueio está ativo. */
  request(): Promise<boolean> {
    this.wanted = true;
    return this.acquire();
  }

  /** Solta a tela acesa (ao terminar o treino) e para de pedir de novo. */
  async release(): Promise<void> {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    this._active.set(false);
    try {
      await sentinel?.release();
    } catch {
      // Já solto pelo sistema: nada a fazer.
    }
  }

  private acquire(): Promise<boolean> {
    if (this.lock === undefined) return Promise.resolve(false);
    if (this.sentinel !== null && !this.sentinel.released) return Promise.resolve(true);
    const lock = this.lock;
    this.acquiring ??= Promise.resolve()
      .then(() => lock.request('screen'))
      .then((sentinel) => {
        if (!this.wanted) {
          // O dono já terminou o treino enquanto o pedido estava no ar.
          void sentinel.release().catch(() => undefined);
          return false;
        }
        this.sentinel = sentinel;
        this._active.set(true);
        sentinel.addEventListener('release', () => {
          if (this.sentinel === sentinel) {
            this.sentinel = null;
            this._active.set(false);
          }
        });
        return true;
      })
      .catch(() => {
        this._active.set(false);
        return false;
      })
      .finally(() => {
        this.acquiring = null;
      });
    return this.acquiring;
  }
}
