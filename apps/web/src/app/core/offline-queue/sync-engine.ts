import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { AccountScope } from '../session/account-scope';
import { SessionState } from '../session/session-state';
import { SendOutcome, classifyResult } from './classify-result';
import { OutboxItem } from './offline-db';
import { OutboxStore } from './outbox-store';
import { QUEUE_ACCOUNT, QUEUE_READY } from './queue-account';
import { QUEUE_LOCKS, QUEUE_RUNTIME, syncLockName } from './queue-ports';
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
 * Motor de envio da fila de UMA conta (há um por conta, criado pelo escopo dela: `QueueScopes`). Regras:
 * - **um envio por vez** na aba (uma passagem por vez) e **uma aba por vez** (`navigator.locks`, um bloqueio por conta);
 * - **só envia com a sessão desta conta**: se o token em memória é de outra (outra pessoa entrou neste navegador, em
 *   outra aba ou nesta), a fila fica intacta no disco esperando a conta dela voltar. Vale a cada item, não só no começo
 *   da passagem: a troca pode acontecer no meio dela;
 * - ordem **FIFO**; um erro de infraestrutura (rede, 5xx, 429, servidor acordando, 401) interrompe a passagem e
 *   agenda a próxima, para não furar a fila nem martelar o servidor; recusa de negócio (4xx) marca o item
 *   `failed` e **segue** para o próximo;
 * - **nunca desiste por tempo e nunca apaga item** por 401, logout ou erro de rede: só um 2xx remove, e só se o
 *   item não mudou durante o voo;
 * - sem Background Sync (não existe no iPhone): reenvia com o app aberto, ao gravar, ao voltar a rede, ao voltar
 *   para a aba, na partida, no botão e num temporizador de 30 s que só existe com pendência e página visível.
 */
@Injectable()
export class SyncEngine {
  private readonly store = inject(OutboxStore);
  private readonly transport = inject(QUEUE_TRANSPORT);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly locks = inject(QUEUE_LOCKS);
  private readonly connectivity = inject(ConnectivityService);
  private readonly session = inject(SessionState);
  private readonly account = inject(AccountScope);
  private readonly accountId = inject(QUEUE_ACCOUNT);
  private readonly ready = inject(QUEUE_READY);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;

  private readonly _syncing = signal(false);
  /** Verdadeiro enquanto esta aba envia. */
  readonly syncing = this._syncing.asReadonly();

  private started: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private requested = false;
  private forceRequested = false;
  /** Depois de `stop()` o motor não começa nada novo: a conta saiu de cena e o banco vai ser fechado. */
  private stopped = false;
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
      this.stopped = true;
      this.win?.removeEventListener('online', onOnline);
      this.doc.removeEventListener('visibilitychange', onVisibility);
      this.clearTimers();
    });

    // Uma sessão que acaba de ficar pronta é motivo para tentar o que esperava por ela. Também conta o dono da sessão (o
    // `sub` do token ou o `/me`) e cada token novo (uma renovação): o item que ficou esperando um token desta conta sai
    // assim que ele chega, sem esperar o relógio.
    effect(() => {
      if (this.session.status() === 'authenticated') {
        this.account.sessionAccount();
        this.session.expiresAt();
        untracked(() => void this.kick({ force: true }));
      }
    });
  }

  /**
   * Hidrata (lê o IndexedDB) e faz a primeira passagem. Idempotente. Chamado na partida do app; quem grava na
   * fila também o chama, então nada fica esperando por uma chamada que ninguém fez.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        // O banco antigo, se for a vez desta conta, é adotado antes de qualquer leitura ou envio.
        await this.ready;
        if (this.stopped) return;
        await this.store.refresh();
        this.updateTimers();
        await this.drain({ force: true });
      } catch (error) {
        // A conta saiu de cena no meio da partida: o banco dela vai ser fechado, e o que sobrou dela não é erro do app.
        if (!this.stopped) throw error;
      }
    })();
    return this.started;
  }

  /**
   * A conta saiu de cena (outra entrou, ou ninguém): não começa mais nada, solta os temporizadores e espera a passagem em
   * andamento terminar (um item em voo é concluído no banco antes de ele ser fechado). Idempotente.
   */
  stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    return this.whenIdle();
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
    return this.started && !this.stopped ? this.drain(options) : Promise.resolve();
  }

  private async loop(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        const force = this.forceRequested;
        this.forceRequested = false;
        await this.pass(force);
      }
    } catch (error) {
      // Parado no meio (a conta saiu de cena): o que sobrou é problema do banco que vai ser fechado, não do app.
      if (!this.stopped) throw error;
    } finally {
      // Dentro do `finally` (e não num `.finally()` de fora): nenhum pedido cai na fresta entre o fim do laço e a
      // liberação, o que deixaria um item gravado agora esperando o temporizador.
      this.draining = null;
    }
  }

  /**
   * Pode mexer na fila e falar com o servidor agora? Só com sessão, e só se a sessão é desta conta: o token de outra
   * pessoa gravaria os dados desta no usuário errado.
   */
  private mayOperate(): boolean {
    return (
      !this.stopped &&
      this.session.status() !== 'anonymous' &&
      this.account.isSessionOf(this.accountId)
    );
  }

  private async pass(force: boolean): Promise<void> {
    // Sem sessão (ou com a sessão de outra conta) não há com quem falar; o que está na fila fica onde está até a conta
    // dela voltar.
    if (!this.mayOperate()) return;
    // Sem rede não há o que tentar: o evento `online` volta aqui. Não gasta tentativa nem aumenta o backoff.
    if (!this.connectivity.online()) return;

    const result = await this.locks.tryRun(syncLockName(this.accountId), () =>
      this.sendInOrder(force),
    );
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
        // A troca de sessão ou de conta pode acontecer no meio da passagem: confere antes de cada item.
        if (!this.mayOperate()) return;
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

        // Marcar leva tempo: se a sessão deixou de ser desta conta nesse intervalo, o item não sai (e a tentativa não conta).
        if (!this.mayOperate()) {
          await this.store.giveBack(sending.id, sending.revision);
          return;
        }

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
      accountId: this.accountId,
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
      !this.stopped &&
      this.store.pendingCount() > 0 &&
      this.visible() &&
      this.session.status() !== 'anonymous';
    if (!needed) {
      this.clearTimers();
      return;
    }
    this.pollTimer ??= this.runtime.setInterval(() => void this.drain(), POLL_INTERVAL_MS);
  }

  private scheduleWake(at: number): void {
    if (this.wakeTimer !== undefined) this.runtime.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.stopped || !this.visible()) return;
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
