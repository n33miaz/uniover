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
 * Tela acesa durante o treino (Wake Lock). É melhor esforço: no iPhone existe no Safari desde o iOS 16.4, mas o app aberto
 * pela tela de início só a manteve acesa a partir do iOS 18.4 (antes, o pedido era aceito e o bloqueio não valia), e a
 * bateria baixa, a falta de permissão ou o sistema podem recusar. Nada disto foi conferido num aparelho. **Nenhum erro aqui
 * quebra o treino**: `request()` devolve `false` e os sinais `active` e `refused` dizem a verdade.
 *
 * O navegador solta o bloqueio sozinho quando a página some (aba trocada, tela bloqueada); por isso, enquanto o dono
 * quer a tela acesa, o bloqueio é pedido de novo na volta para a página visível.
 *
 * `refused` diz a verdade para a tela contar com calma: a pessoa quis a tela acesa e o aparelho não a manteve (pedido
 * recusado, ou o sistema soltou o bloqueio com a página à vista, como o iOS costuma fazer em app instalado). Falta da
 * API não é recusa: nela `supported` já é falso.
 */
@Injectable()
export class WakeLockService {
  private readonly doc = inject(DOCUMENT);
  private readonly lock = (
    this.doc.defaultView?.navigator as { wakeLock?: WakeLockLike } | undefined
  )?.wakeLock;

  private readonly _supported = signal(this.lock !== undefined);
  private readonly _active = signal(false);
  private readonly _refused = signal(false);
  private wanted = false;
  private sentinel: SentinelLike | null = null;
  private acquiring: Promise<boolean> | null = null;

  /** O navegador tem a API de tela acesa. */
  readonly supported = this._supported.asReadonly();
  /** Há um bloqueio de tela ativo agora. */
  readonly active = this._active.asReadonly();
  /** A pessoa quer a tela acesa e o aparelho não a manteve (recusou, ou soltou e não deu para pedir de novo). */
  readonly refused = this._refused.asReadonly();

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
    this._refused.set(false);
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
        this._refused.set(false);
        sentinel.addEventListener('release', () => {
          if (this.sentinel === sentinel) {
            this.sentinel = null;
            this._active.set(false);
            // Com a página escondida (aba trocada, tela bloqueada) soltar é o esperado e a volta pede de novo; à vista, o
            // aparelho tomou o bloqueio de volta e não há como saber se o devolve: a tela passa a dizer a verdade.
            if (this.wanted && this.doc.visibilityState === 'visible') this._refused.set(true);
          }
        });
        return true;
      })
      .catch(() => {
        this._active.set(false);
        // Recusa (bateria baixa, economia de energia, falta de permissão): só conta se a pessoa ainda quer a tela acesa.
        if (this.wanted) this._refused.set(true);
        return false;
      })
      .finally(() => {
        this.acquiring = null;
      });
    return this.acquiring;
  }
}
