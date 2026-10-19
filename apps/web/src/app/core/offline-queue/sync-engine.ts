import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { SessionState } from '../session/session-state';
import { SendOutcome, classifyResult } from './classify-result';
import { OutboxItem } from './offline-db';
import { OutboxStore } from './outbox-store';
import { QUEUE_LOCKS, QUEUE_RUNTIME, SYNC_LOCK_NAME } from './queue-ports';
import { QUEUE_TRANSPORT, QueueRequest } from './queue-transport';

/** Intervalo do temporizador de reserva: só existe com pendência e página visível. */
export const POLL_INTERVAL_MS = 30_000;

/** Espera depois de um 401 antes de tentar o mesmo item de novo (a sessão pode ser renovada nesse meio tempo). */
export const AUTH_RETRY_MS = 10_000;

export interface DrainOptions {
  /**
   * Ignora a espera do backoff e tenta já. Usado quando algo mudou de fato (voltou a rede, o usuário voltou ao
   * app, apertou "sincronizar agora"); o temporizador e a gravação de um item novo respeitam a espera.
   */
  readonly force?: boolean;
}

/**
 * Motor de envio da fila. Regras:
 * - **um envio por vez** na aba (uma passagem por vez) e **uma aba por vez** (`navigator.locks`);
 * - ordem **FIFO**; um erro de infraestrutura (rede, 5xx, 429, servidor acordando, 401) interrompe a passagem e
 *   agenda a próxima, para não furar a fila nem martelar o servidor; recusa de negócio (4xx) marca o item
 *   `failed` e **segue** para o próximo;
 * - **nunca desiste por tempo e nunca apaga item** por 401, logout ou erro de rede: só um 2xx remove, e só se o
 *   item não mudou durante o voo;
 * - sem Background Sync (não existe no iPhone): reenvia com o app aberto, ao gravar, ao voltar a rede, ao voltar
 *   para a aba, na partida, no botão e num temporizador de 30 s que só existe com pendência e página visível.
 */
@Injectable({ providedIn: 'root' })
export class SyncEngine {
  private readonly store = inject(OutboxStore);
  private readonly transport = inject(QUEUE_TRANSPORT);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly locks = inject(QUEUE_LOCKS);
  private readonly connectivity = inject(ConnectivityService);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;

  private readonly _syncing = signal(false);
  /** Verdadeiro enquanto esta aba envia. */
  readonly syncing = this._syncing.asReadonly();

  private started: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private requested = false;
  private forceRequested = false;
  /** Pendente até a primeira passagem com o bloqueio em mãos (só então ninguém mais está enviando). */
  private needsReset = true;
  private pollTimer: unknown;
  private wakeTimer: unknown;

  constructor() {
    const onOnline = () => void this.kick({ force: true });
    const onVisibility = () => {
      if (this.doc.visibilityState === 'visible') {
        void this.store.refresh().then(() => this.updateTimers());
        void this.kick({ force: true });
      } else {
        this.clearTimers();
      }
    };
    this.win?.addEventListener('online', onOnline);
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      this.win?.removeEventListener('online', onOnline);
      this.doc.removeEventListener('visibilitychange', onVisibility);
      this.clearTimers();
    });

    // Uma sessão que acaba de ficar pronta é motivo para tentar o que esperava por ela.
    effect(() => {
      if (this.session.status() === 'authenticated')
        untracked(() => void this.kick({ force: true }));
    });
  }

  /**
   * Hidrata (lê o IndexedDB) e faz a primeira passagem. Idempotente. Chamado na partida do app; quem grava na
   * fila também o chama, então nada fica esperando por uma chamada que ninguém fez.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      await this.store.refresh();
      this.updateTimers();
      await this.drain({ force: true });
    })();
    return this.started;
  }

  /** Pede uma passagem de envio. Várias chamadas seguidas viram uma só passagem extra, sem perder nenhuma. */
  drain(options: DrainOptions = {}): Promise<void> {
    this.requested = true;
    this.forceRequested ||= options.force === true;
    this.draining ??= this.loop();
    return this.draining;
  }

  /** Resolve quando não há passagem em andamento nem pedida (sem pedir uma nova). */
  whenIdle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  private kick(options: DrainOptions): Promise<void> {
    // Antes de `start()` o banco ainda não foi hidratado: quem chama `start()` já faz a primeira passagem.
    return this.started ? this.drain(options) : Promise.resolve();
  }

  private async loop(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        const force = this.forceRequested;
        this.forceRequested = false;
        await this.pass(force);
      }
    } finally {
      // Dentro do `finally` (e não num `.finally()` de fora): nenhum pedido cai na fresta entre o fim do laço e a
      // liberação, o que deixaria um item gravado agora esperando o temporizador.
      this.draining = null;
    }
  }

  private async pass(force: boolean): Promise<void> {
    // Sem sessão não há com quem falar; o que está na fila fica onde está até alguém entrar.
    if (this.session.status() === 'anonymous') return;
    // Sem rede não há o que tentar: o evento `online` volta aqui. Não gasta tentativa nem aumenta o backoff.
    if (!this.connectivity.online()) return;

    const result = await this.locks.tryRun(SYNC_LOCK_NAME, () => this.sendInOrder(force));
    if (!result.ran) await this.store.refresh(); // outra aba envia; só atualiza o que esta aba mostra
    this.updateTimers();
  }

  private async sendInOrder(force: boolean): Promise<void> {
    this._syncing.set(true);
    try {
      if (this.needsReset) {
        await this.store.resetSending();
        this.needsReset = false;
      }

      for (;;) {
        const item = await this.store.oldestPending();
        if (!item) return;

        const now = this.runtime.now();
        if (!force && item.nextAttemptAt > now) {
          this.scheduleWake(item.nextAttemptAt);
          return;
        }
        if (!this.connectivity.online()) return;

        const sending = await this.store.markSending(item.id, item.revision);
        if (!sending) continue; // mudou desde a leitura: relê o mais antigo

        const outcome = await this.send(sending);
        const decision = classifyResult(outcome, {
          failures: sending.attempts,
          nowMs: this.runtime.now(),
          random: this.runtime.random(),
        });

        switch (decision.action) {
          case 'done':
            await this.store.complete(sending.id, sending.revision);
            break;
          case 'failed':
            await this.store.markFailed(sending.id, sending.revision, decision.reason);
            break;
          case 'auth': {
            // Fica na fila, sem contar como falha: o interceptador já tentou renovar a sessão e não deu.
            const at = this.runtime.now() + AUTH_RETRY_MS;
            await this.store.scheduleRetry(sending.id, sending.revision, at, 'unauthenticated');
            this.scheduleWake(at);
            return;
          }
          case 'retry': {
            const at = this.runtime.now() + decision.delayMs;
            await this.store.scheduleRetry(sending.id, sending.revision, at, decision.reason);
            this.scheduleWake(at);
            return;
          }
        }
      }
    } finally {
      this._syncing.set(false);
    }
  }

  private async send(item: OutboxItem): Promise<SendOutcome> {
    const request: QueueRequest = {
      method: item.method,
      url: item.url,
      body: item.body,
      // A mesma chave em toda tentativa do mesmo item: é o que deixa o servidor reconhecer o reenvio.
      headers: { 'Idempotency-Key': item.id, 'Content-Type': 'application/json' },
    };
    try {
      return await this.transport.send(request);
    } catch {
      // Um transporte que lança sem classificar é tratado como rede que não entregou: tenta de novo depois.
      return { kind: 'network-error' };
    }
  }

  private visible(): boolean {
    return this.doc.visibilityState !== 'hidden';
  }

  /** Temporizadores só existem com pendência, página visível e sessão; senão nada acorda o app nem o servidor. */
  private updateTimers(): void {
    const needed =
      this.store.pendingCount() > 0 && this.visible() && this.session.status() !== 'anonymous';
    if (!needed) {
      this.clearTimers();
      return;
    }
    this.pollTimer ??= this.runtime.setInterval(() => void this.drain(), POLL_INTERVAL_MS);
  }

  private scheduleWake(at: number): void {
    if (this.wakeTimer !== undefined) this.runtime.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (!this.visible()) return;
    this.wakeTimer = this.runtime.setTimeout(
      () => {
        this.wakeTimer = undefined;
        void this.drain();
      },
      Math.max(at - this.runtime.now(), 0),
    );
  }

  private clearTimers(): void {
    if (this.pollTimer !== undefined) this.runtime.clearInterval(this.pollTimer);
    if (this.wakeTimer !== undefined) this.runtime.clearTimeout(this.wakeTimer);
    this.pollTimer = undefined;
    this.wakeTimer = undefined;
  }
}
