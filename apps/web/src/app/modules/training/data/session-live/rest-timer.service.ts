import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import {
  ADD_REST_MS,
  extendRest,
  isOver,
  remainingMs,
  restEndsAt,
} from '../../domain/session/rest-timer';
import { META_REST_ENDS_AT } from '../sessions/session-repository';
import { TRAINING_DB } from '../training-db';
import { RestAlert } from './rest-alert';

/** Intervalo do tique do descanso (só existe com timer ativo e página visível). */
export const REST_TICK_MS = 1000;

/**
 * Timer de descanso. Guarda o **instante de fim** (`endsAt`), nunca um contador, e o grava no `meta` (`restEndsAt`):
 * recarregar a página ou bloquear a tela não perde o descanso, e ao voltar o tempo restante é recalculado do relógio.
 *
 * O tique de 1 s só existe enquanto há timer **ativo** (não acabou) **e** a página está visível: nada de `setInterval`
 * à toa. Ao zerar durante o tique avisa uma vez (vibração e som, se disponíveis). Com a tela bloqueada o JavaScript é
 * suspenso e **não há aviso**; ao voltar, o descanso aparece como acabado, sem apitar (o aviso já não faz sentido).
 */
@Injectable()
export class RestTimerService {
  private readonly db = inject(TRAINING_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly alert = inject(RestAlert);
  private readonly doc = inject(DOCUMENT);

  private readonly _endsAt = signal<number | null>(null);
  private readonly _now = signal(this.runtime.now());
  private tick: unknown = null;

  /** Instante (ms) em que o descanso termina, ou `null` sem timer. */
  readonly endsAt = this._endsAt.asReadonly();
  /** Há um timer (ativo ou já vencido, esperando o dono tocar em pular ou iniciar o próximo). */
  readonly active = computed(() => this._endsAt() !== null);
  /** Quanto falta, em ms; muda a cada tique enquanto a página está visível. */
  readonly remaining = computed(() => remainingMs(this._endsAt(), this._now()));
  /** O descanso acabou. */
  readonly over = computed(() => isOver(this._endsAt(), this._now()));

  constructor() {
    const onVisibility = () => {
      if (this.visible()) {
        // Voltou: recalcula do relógio (sem avisar do que acabou enquanto a tela estava bloqueada) e retoma o tique.
        this._now.set(this.runtime.now());
        this.syncTick();
      } else {
        this.stopTick();
      }
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onVisibility);
      this.stopTick();
    });
  }

  /** Relê o fim do descanso guardado (depois de recarregar a página). Descanso já vencido volta como "acabou". */
  async restore(): Promise<void> {
    const stored = (await this.db.meta.get(META_REST_ENDS_AT))?.value;
    this._endsAt.set(typeof stored === 'number' ? stored : null);
    this._now.set(this.runtime.now());
    this.syncTick();
  }

  /** Começa um descanso de `seconds` a partir de agora. */
  async start(seconds: number): Promise<void> {
    await this.set(restEndsAt(this.runtime.now(), seconds));
  }

  /** Soma tempo ao descanso (15 s por padrão). Sem timer, não faz nada. */
  async add(ms: number = ADD_REST_MS): Promise<void> {
    const current = this._endsAt();
    if (current === null) return;
    await this.set(extendRest(current, this.runtime.now(), ms));
  }

  /** Pula o descanso: apaga o timer. */
  async skip(): Promise<void> {
    await this.set(null);
  }

  /** Libera o som do aviso. A tela chama no toque de "Iniciar treino" (o navegador exige um gesto prévio). */
  unlockAudio(): void {
    this.alert.unlock();
  }

  private async set(endsAt: number | null): Promise<void> {
    this._endsAt.set(endsAt);
    this._now.set(this.runtime.now());
    this.syncTick();
    if (endsAt === null) await this.db.meta.delete(META_REST_ENDS_AT);
    else await this.db.meta.put({ key: META_REST_ENDS_AT, value: endsAt });
  }

  private visible(): boolean {
    return this.doc.visibilityState !== 'hidden';
  }

  /** O tique existe só com timer ativo (não vencido) e página visível. */
  private syncTick(): void {
    const needed =
      this.visible() && this._endsAt() !== null && !isOver(this._endsAt(), this._now());
    if (needed && this.tick === null) {
      this.tick = this.runtime.setInterval(() => this.onTick(), REST_TICK_MS);
    } else if (!needed) {
      this.stopTick();
    }
  }

  private onTick(): void {
    this._now.set(this.runtime.now());
    if (this.over()) {
      this.stopTick();
      this.alert.fire();
    }
  }

  private stopTick(): void {
    if (this.tick === null) return;
    this.runtime.clearInterval(this.tick);
    this.tick = null;
  }
}
