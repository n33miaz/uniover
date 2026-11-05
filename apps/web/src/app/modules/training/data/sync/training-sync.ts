import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { AccountScope } from '../../../../core/session/account-scope';
import { TRAINING_DB } from '../training-db';
import { CURSOR_REWIND_MS, rewindCursor } from './cursor';
import { PullApi } from './pull-api';
import { DEFAULT_PULL_PAGE_SIZE, ResourceSync, TRAINING_RESOURCE_SYNCS } from './resource-sync';

/**
 * Por que o último puxar falhou, sem texto: a tela escolhe a mensagem ("usando o que está no aparelho desde
 * HH:MM"). `network`: sem resposta · `server`: 5xx, 408 ou 429 (servidor acordando ou ocupado) · `unexpected`:
 * qualquer outra coisa.
 */
export type TrainingSyncError = 'network' | 'server' | 'unexpected';

/**
 * Quanto quem espera a primeira passada do servidor (Hoje, Rotinas, Progresso, Corpo...) espera no máximo, contado da hora
 * em que a passada pode começar (banco lido, fila hidratada, com rede): passado o prazo, o que o banco local tem vale, mesmo
 * com a requisição pendurada (portal cativo, TCP sem resposta). É o único lugar deste número.
 */
export const FIRST_PULL_WAIT_MS = new InjectionToken<number>('FIRST_PULL_WAIT_MS', {
  providedIn: 'root',
  factory: () => 8_000,
});

/**
 * Teto de segurança, contado da criação do puxador: vale quando a passada nem chega a poder começar (o banco ou a fila
 * pendurados na hidratação). É maior que `FIRST_PULL_WAIT_MS` de propósito: uma hidratação lenta não gasta o prazo da
 * passada, mas também não deixa o esqueleto durar para sempre.
 */
export const FIRST_PULL_BOOT_MAX_MS = new InjectionToken<number>('FIRST_PULL_BOOT_MAX_MS', {
  providedIn: 'root',
  factory: () => 30_000,
});

function classify(error: unknown): TrainingSyncError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'network';
    if (error.status >= 500 || error.status === 408 || error.status === 429) return 'server';
  }
  return 'unexpected';
}

/**
 * Puxador genérico do Treino: traz do servidor, por cursor, o que mudou em cada recurso registrado
 * (`ResourceSync`) e funde no banco local. A tela lê sempre do banco; isto só o mantém em dia.
 *
 * Regras:
 * - **só puxa com a fila de escrita vazia**: o que o aparelho escreveu sobe antes, para o servidor já ter visto
 *   tudo (hidratar e enviar antes de puxar);
 * - **só puxa com a sessão da conta deste banco**: com o token de outra conta (outra pessoa entrou neste navegador), o que
 *   o servidor devolvesse seria dela e entraria no banco local desta;
 * - **uma passada por vez**, e pedido que chega no meio vira uma passada extra (nenhum se perde);
 * - gatilhos: a partida do módulo (`start()`), o evento `online`, a volta à aba, o fim de um envio da fila
 *   (`lastSyncAt` mudou) e o botão manual (`pullNow()`). **Nenhum temporizador**: o servidor dorme de graça e
 *   não é acordado à toa;
 * - falha de rede ou de servidor não é exceção: vira o sinal `error`, e o aparelho segue com o que tem;
 * - cada pass recua o cursor em 2 minutos na primeira página (`CURSOR_REWIND_MS`); reaplicar é idempotente.
 */
@Injectable()
export class TrainingSync {
  private readonly db = inject(TRAINING_DB);
  private readonly resources = inject(TRAINING_RESOURCE_SYNCS, { optional: true }) ?? [];
  private readonly api = inject(PullApi);
  private readonly queue = inject(OfflineQueue);
  private readonly account = inject(AccountScope);
  private readonly connectivity = inject(ConnectivityService);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly doc = inject(DOCUMENT);

  private readonly _pulling = signal(false);
  private readonly _lastPullAt = signal<number | null>(null);
  private readonly _error = signal<TrainingSyncError | null>(null);
  private readonly _firstPassSettled = signal(false);
  private readonly _firstPullWaitExpired = signal(false);

  /** Há um puxar em andamento. */
  readonly pulling = this._pulling.asReadonly();
  /** Instante (ms) do último puxar completo, ou `null` se este aparelho ainda não puxou. */
  readonly lastPullAt = this._lastPullAt.asReadonly();
  /** Motivo da falha do último puxar; `null` quando deu certo (ou ainda não rodou). */
  readonly error = this._error.asReadonly();
  /**
   * A primeira passada já decidiu o que podia: puxou, falhou, ou concluiu que não vai puxar agora (fila com envio
   * pendente, conta sem dono, nada a puxar). Quem espera "o primeiro puxar" para não mostrar um vazio falso para de
   * esperar aqui, em vez de ficar num esqueleto que nunca acaba; o banco local passa a valer.
   */
  readonly firstPassSettled = this._firstPassSettled.asReadonly();
  /**
   * O prazo da espera acabou sem a primeira passada decidir (ver `FIRST_PULL_WAIT_MS`): quem espera deixa de esperar.
   * O prazo corre da hora em que a passada pode começar, não da criação: hidratação lenta não o consome; se nem assim ela
   * começa, vale o teto `FIRST_PULL_BOOT_MAX_MS`.
   */
  readonly firstPullWaitExpired = this._firstPullWaitExpired.asReadonly();
  private readonly _lastPullKnown = signal(false);
  /**
   * O instante do último puxar já foi lido do banco (mesmo que seja "nunca"). Antes disso `lastPullAt` vale `null` para
   * todo mundo, e quem já tem dados no aparelho seria tomado por um aparelho novo.
   */
  readonly lastPullKnown = this._lastPullKnown.asReadonly();

  private starting: Promise<void> | null = null;
  private started = false;
  private running: Promise<void> | null = null;
  private requested = false;
  private seenSyncAt: number | null = null;
  private readonly waitMs = inject(FIRST_PULL_WAIT_MS);
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitArmed = false;

  constructor() {
    this.waitTimer = setTimeout(
      () => this._firstPullWaitExpired.set(true),
      inject(FIRST_PULL_BOOT_MAX_MS),
    );
    inject(DestroyRef).onDestroy(() => this.clearWaitTimer());
    const win = this.doc.defaultView;
    const onOnline = () => void this.request();
    const onVisibility = () => {
      if (this.doc.visibilityState === 'visible') void this.request();
    };
    win?.addEventListener('online', onOnline);
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      win?.removeEventListener('online', onOnline);
      this.doc.removeEventListener('visibilitychange', onVisibility);
    });

    // Um envio da fila que terminou (o carimbo mudou) é motivo para puxar: se foi o último, a fila esvaziou.
    effect(() => {
      const syncedAt = this.queue.lastSyncAt();
      untracked(() => {
        if (syncedAt === this.seenSyncAt) return;
        this.seenSyncAt = syncedAt;
        void this.request();
      });
    });

    // A sessão ganha dona quando o `/me` responde (a partida sem rede abre o banco pela dica da conta, e a passada espera
    // por isto): é motivo para puxar o que esperava.
    effect(() => {
      if (this.account.sessionAccount() !== null) untracked(() => void this.request());
    });
  }

  /**
   * Chamado pela casca do módulo ao entrar. Lê quando foi o último puxar, espera a fila ser hidratada (sem isso
   * `pendingCount` mostra 0 mesmo com envio pendente) e faz a primeira passada. Idempotente.
   */
  start(): Promise<void> {
    this.starting ??= this.boot().catch((error: unknown) => {
      // Não deu para hidratar a fila: não puxa (a regra é fila vazia). Uma próxima chamada tenta de novo.
      this._error.set(classify(error));
      this.starting = null;
    });
    return this.starting;
  }

  /** Botão manual: sobe o que está na fila e puxa em seguida. Resolve quando a passada termina. */
  async pullNow(): Promise<void> {
    await this.start();
    await this.queue.syncNow();
    await this.request();
  }

  private async boot(): Promise<void> {
    this._lastPullAt.set(await this.readLastPullAt());
    this._lastPullKnown.set(true);
    await this.queue.start();
    this.seenSyncAt = this.queue.lastSyncAt();
    this.started = true;
    await this.request();
  }

  /** O instante mais antigo entre os recursos: o aparelho só está "em dia desde" quando todos estão. */
  private async readLastPullAt(): Promise<number | null> {
    if (this.resources.length === 0) return null;
    let oldest: number | null = null;
    for (const resource of this.resources) {
      const at = (await this.db.syncState.get(resource.resource))?.lastPullAt ?? null;
      if (at === null) return null;
      oldest = oldest === null ? at : Math.min(oldest, at);
    }
    return oldest;
  }

  private clearWaitTimer(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  /** A primeira passada decidiu: o prazo da espera não é mais necessário. */
  private settle(): void {
    this._firstPassSettled.set(true);
    this.clearWaitTimer();
  }

  /** Troca o teto de partida pelo prazo da passada, uma vez, quando ela pode de fato começar (rede, banco e fila prontos). */
  private armWaitDeadline(): void {
    if (this.waitArmed || this._firstPassSettled()) return;
    this.waitArmed = true;
    this.clearWaitTimer();
    this.waitTimer = setTimeout(() => this._firstPullWaitExpired.set(true), this.waitMs);
  }

  /** Pede uma passada. Pedidos seguidos viram uma passada extra só; antes de `start()` não faz nada. */
  private request(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.requested = true;
    this.running ??= this.loop();
    return this.running;
  }

  private async loop(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        await this.pass();
      }
    } finally {
      // Dentro do `finally`, para nenhum pedido cair na fresta entre o fim do laço e a liberação.
      this.running = null;
    }
  }

  private async pass(): Promise<void> {
    // Sem rede não há o que tentar (o evento `online` volta aqui) e isso não é erro. Com envio pendente, a fila
    // sobe primeiro; o fim do envio chama de novo.
    if (this.resources.length === 0) {
      this.settle();
      return;
    }
    if (!this.connectivity.online()) return;
    // A partir daqui a passada pode começar: só agora o prazo da espera corre.
    this.armWaitDeadline();
    if (this.queue.pendingCount() > 0) {
      this.settle();
      return;
    }
    // Só com a sessão da conta dona deste banco: o token de outra conta traria os dados dela para cá.
    const accountId = this.queue.accountId;
    if (accountId === null || !this.account.isSessionOf(accountId)) {
      // Sem a resposta do `/me` a passada ainda vai acontecer; com ela e sem ser a dona, nunca vai.
      if (this.account.sessionAccount() !== null) this.settle();
      return;
    }

    this._pulling.set(true);
    try {
      for (const resource of this.resources) await this.pullResource(resource, accountId);
      this._error.set(null);
      this._lastPullAt.set(this.runtime.now());
    } catch (error) {
      this._error.set(classify(error));
    } finally {
      this.settle();
      this._pulling.set(false);
    }
  }

  private async pullResource(resource: ResourceSync, accountId: string): Promise<void> {
    const name = resource.resource;
    const previous = await this.db.syncState.get(name);
    const limit = resource.pageSize ?? DEFAULT_PULL_PAGE_SIZE;

    let stored = previous?.cursor ?? null;
    // Só o primeiro pedido recua o cursor; as páginas seguintes seguem o cursor que o servidor devolveu.
    let after = stored === null ? null : rewindCursor(stored, CURSOR_REWIND_MS);

    for (;;) {
      const page = await this.api.fetchPage<unknown>(resource.path, after, limit, accountId);

      // Página vazia devolve o cursor que recebeu (recuado): guardá-lo faria o cursor andar para trás a cada puxar.
      if (page.items.length > 0) {
        await resource.merge(page.items);
        if (page.nextCursor !== null) {
          stored = page.nextCursor;
          // Guardado a cada página: um puxar interrompido continua de onde parou.
          await this.db.syncState.put({
            resource: name,
            cursor: stored,
            lastPullAt: previous?.lastPullAt ?? null,
          });
        }
      }

      // Acabou quando a página veio incompleta, vazia ou sem cursor novo (`nextCursor` nulo não quer dizer "fim":
      // o servidor devolve o último cursor mesmo na última página).
      if (page.items.length < limit || page.nextCursor === null || page.nextCursor === after) break;
      after = page.nextCursor;
    }

    await this.db.syncState.put({ resource: name, cursor: stored, lastPullAt: this.runtime.now() });
  }
}
