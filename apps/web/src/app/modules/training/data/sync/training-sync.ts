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
import { ResumeGrace } from '../../../../core/connectivity/resume-grace';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { AccountScope } from '../../../../core/session/account-scope';
import { TRAINING_DB } from '../training-db';
import { CURSOR_REWIND_MS, rewindCursor } from './cursor';
import { PullApi, PullTimeoutError } from './pull-api';
import {
  DEFAULT_PULL_PAGE_SIZE,
  PullPage,
  ResourceSync,
  TRAINING_RESOURCE_SYNCS,
} from './resource-sync';

/**
 * Por que o último puxar falhou, sem texto: a tela escolhe a mensagem ("usando o que está no aparelho desde
 * HH:MM"). `network`: sem resposta · `server`: 5xx, 408 ou 429 (servidor acordando ou ocupado) · `unexpected`:
 * qualquer outra coisa.
 */
export type TrainingSyncError = 'network' | 'server' | 'unexpected';

/**
 * Quanto quem espera a primeira passada do servidor (Hoje, Rotinas, Progresso, Corpo...) espera no máximo **sem notícia da
 * rede**: o prazo corre da hora em que a passada pode começar (banco lido, fila hidratada, com rede) e volta a zero a cada
 * resposta recebida; passado o prazo em silêncio, o que o banco local tem vale, mesmo com a requisição pendurada (portal
 * cativo, TCP sem resposta). Enquanto o aparelho grava o que chegou (a escrita local) o prazo de silêncio não corre: uma
 * gravação lenta não é silêncio da rede (o que a limita é `FIRST_PULL_WRITE_STALL_MS`). Não há teto no tempo total: uma
 * passada lenta mas viva nunca é cortada. É o único lugar deste número.
 */
export const FIRST_PULL_WAIT_MS = new InjectionToken<number>('FIRST_PULL_WAIT_MS', {
  providedIn: 'root',
  factory: () => 8_000,
});

/**
 * Quanto a gravação local pode ficar **sem andar** antes de a espera acabar: o prazo de silêncio não corre enquanto o
 * aparelho grava o que chegou, mas um banco pendurado numa gravação não pode deixar o esqueleto para sempre. Conta da
 * última prova de vida (página gravada, cursor guardado), então uma passada lenta que segue gravando nunca o atinge.
 */
export const FIRST_PULL_WRITE_STALL_MS = new InjectionToken<number>('FIRST_PULL_WRITE_STALL_MS', {
  providedIn: 'root',
  factory: () => 45_000,
});

/**
 * Quanto um pedido de página ao servidor pode ficar sem resposta antes de ser abandonado (e cancelado): portal cativo ou TCP
 * sem resposta não podem manter `pulling()` ligado para sempre (Hoje, Biblioteca e Mapa mostram "Baixando o catálogo…" enquanto
 * ele vale). Abandonado, a passada falha como erro de rede, o aparelho segue com o que tem e o próximo gatilho tenta de novo
 * a partir do cursor guardado.
 */
export const PULL_REQUEST_TIMEOUT_MS = new InjectionToken<number>('PULL_REQUEST_TIMEOUT_MS', {
  providedIn: 'root',
  factory: () => 20_000,
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
  if (error instanceof PullTimeoutError) return 'network';
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
  private readonly resumeGrace = inject(ResumeGrace);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly doc = inject(DOCUMENT);

  private readonly _pulling = signal(false);
  private readonly _lastPullAt = signal<number | null>(null);
  private readonly _error = signal<TrainingSyncError | null>(null);
  private readonly _firstPassSettled = signal(false);
  private readonly _firstPullWaitExpired = signal(false);
  private readonly _pulledResources = signal<ReadonlySet<string>>(new Set());

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
  /**
   * Os recursos que já foram puxados do servidor até o fim, nesta abertura do app (o conjunto é trocado a cada um novo, e
   * nunca perde nome). Quem depende só de alguns recursos para decidir um vazio (Rotinas, Corpo...) espera por eles em
   * vez de esperar a passada inteira: ver `resourcesPulled`.
   */
  readonly pulledResources = this._pulledResources.asReadonly();
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
  private readonly stallMs = inject(FIRST_PULL_WRITE_STALL_MS);
  private readonly requestMs = inject(PULL_REQUEST_TIMEOUT_MS);
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitArmed = false;
  private priority: readonly string[] = [];
  /** A repetição agendada para o fim da carência da volta ao app; sai junto com o puxador (a tela do Treino fechou). */
  private cancelGraceRetry: (() => void) | null = null;

  constructor() {
    this.waitTimer = setTimeout(
      () => this._firstPullWaitExpired.set(true),
      inject(FIRST_PULL_BOOT_MAX_MS),
    );
    inject(DestroyRef).onDestroy(() => {
      this.clearWaitTimer();
      this.cancelGraceRetry?.();
      this.cancelGraceRetry = null;
    });
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

  /**
   * Todos os recursos citados já foram puxados nesta abertura do app? Lê o sinal: serve dentro de `effect`/`computed`.
   * Só adianta a resposta; o prazo e o fim da passada (`firstPassSettled`, `firstPullWaitExpired`) continuam valendo
   * para quem consulta por `awaitingFirstPull`.
   */
  resourcesPulled(names: readonly string[]): boolean {
    const pulled = this._pulledResources();
    return names.every((name) => pulled.has(name));
  }

  /**
   * A tela que está aberta diz de quais recursos ela precisa: a passada, que puxa um recurso de cada vez, começa por
   * eles (na ordem dada) e só depois segue a ordem de registro. Assim quem abre o endereço de Rotinas não espera, por
   * exemplo, o catálogo de exercícios (a maior resposta) antes de ver as rotinas. Vale para a passada em curso (a escolha
   * do próximo recurso é feita a cada recurso) e para as seguintes; a última tela que pede ganha.
   */
  prioritize(names: readonly string[]): void {
    this.priority = names;
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

  /** A primeira passada decidiu: nenhum prazo da espera é mais necessário. */
  private settle(): void {
    this._firstPassSettled.set(true);
    this.clearWaitTimer();
  }

  private expireWait(): void {
    this._firstPullWaitExpired.set(true);
    this.clearWaitTimer();
  }

  /**
   * Troca o teto de partida pelo prazo da passada, uma vez, quando ela pode de fato começar (rede, banco e fila prontos): o
   * prazo de silêncio (`FIRST_PULL_WAIT_MS`, renovado a cada prova de vida). Não há teto no tempo total.
   */
  private armWaitDeadline(): void {
    if (this.waitArmed || this._firstPassSettled()) return;
    this.waitArmed = true;
    this.clearWaitTimer();
    this.waitTimer = setTimeout(() => this.expireWait(), this.waitMs);
  }

  /**
   * Vai esperar a rede (um pedido ao servidor): o prazo de silêncio começa de novo. Não faz nada antes de a passada poder
   * começar nem depois de ela decidir ou de o prazo acabar.
   */
  private awaitNetwork(): void {
    if (!this.waitArmed || this._firstPassSettled() || this._firstPullWaitExpired()) return;
    this.clearWaitTimer();
    this.waitTimer = setTimeout(() => this.expireWait(), this.waitMs);
  }

  /**
   * A rede respondeu e o resto é trabalho do aparelho (gravar a página no banco): o prazo de silêncio da rede para, e a
   * gravação ganha o seu, bem mais largo (`FIRST_PULL_WRITE_STALL_MS`), que volta a zero a cada passo que andou. Uma
   * gravação lenta (o catálogo, num aparelho lento) não é rede muda e nunca é cortada enquanto avança; só um banco parado.
   */
  private workLocally(): void {
    if (!this.waitArmed || this._firstPassSettled() || this._firstPullWaitExpired()) return;
    this.clearWaitTimer();
    this.waitTimer = setTimeout(() => this.expireWait(), this.stallMs);
  }

  /**
   * Um pedido de página com prazo de silêncio: se o servidor não responde em `PULL_REQUEST_TIMEOUT_MS` (portal cativo, TCP
   * sem resposta), o pedido é cancelado e abandonado, a passada falha como erro de rede e `pulling()` desliga. A corrida
   * vale mesmo que o cancelamento não chegue ao que estiver pendurado (a renovação do token, por exemplo).
   */
  private async fetchWithTimeout(
    resource: ResourceSync,
    after: string | null,
    limit: number,
    accountId: string,
  ): Promise<PullPage<unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PullTimeoutError());
      }, this.requestMs);
    });
    try {
      return await Promise.race([
        this.api.fetchPage<unknown>(resource.path, after, limit, accountId, controller.signal),
        silent,
      ]);
    } finally {
      clearTimeout(timer);
    }
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
      const done = new Set<string>();
      for (let next = this.nextResource(done); next; next = this.nextResource(done)) {
        done.add(next.resource);
        await this.pullResource(next, accountId);
      }
      this._error.set(null);
      this._lastPullAt.set(this.runtime.now());
    } catch (error) {
      const kind = classify(error);
      if (kind === 'network' && this.resumeGrace.active()) {
        // Falha de rede logo ao voltar ao app: o que o aparelho tem segue valendo, sem anel vermelho. A passada refaz quando a
        // carência acabar; se falhar de novo fora dela, aí sim vira erro.
        this.cancelGraceRetry?.();
        this.cancelGraceRetry = this.resumeGrace.afterEnd(() => {
          this.cancelGraceRetry = null;
          void this.request();
        });
      } else {
        this._error.set(kind);
      }
    } finally {
      this.settle();
      this._pulling.set(false);
    }
  }

  /** O próximo recurso a puxar: os que a tela aberta pediu primeiro, depois a ordem de registro. */
  private nextResource(done: ReadonlySet<string>): ResourceSync | undefined {
    for (const name of this.priority) {
      const wanted = this.resources.find((r) => r.resource === name);
      if (wanted && !done.has(name)) return wanted;
    }
    return this.resources.find((r) => !done.has(r.resource));
  }

  private async pullResource(resource: ResourceSync, accountId: string): Promise<void> {
    const name = resource.resource;
    const previous = await this.db.syncState.get(name);
    const limit = resource.pageSize ?? DEFAULT_PULL_PAGE_SIZE;

    let stored = previous?.cursor ?? null;
    // Só o primeiro pedido recua o cursor; as páginas seguintes seguem o cursor que o servidor devolveu.
    let after = stored === null ? null : rewindCursor(stored, CURSOR_REWIND_MS);

    for (;;) {
      this.awaitNetwork();
      const page = await this.fetchWithTimeout(resource, after, limit, accountId);
      this.workLocally();

      // Página vazia devolve o cursor que recebeu (recuado): guardá-lo faria o cursor andar para trás a cada puxar.
      if (page.items.length > 0) {
        await resource.merge(page.items);
        this.workLocally();
        if (page.nextCursor !== null) {
          stored = page.nextCursor;
          // Guardado a cada página: um puxar interrompido continua de onde parou.
          await this.db.syncState.put({
            resource: name,
            cursor: stored,
            lastPullAt: previous?.lastPullAt ?? null,
          });
          this.workLocally();
        }
      }

      // Acabou quando a página veio incompleta, vazia ou sem cursor novo (`nextCursor` nulo não quer dizer "fim":
      // o servidor devolve o último cursor mesmo na última página).
      if (page.items.length < limit || page.nextCursor === null || page.nextCursor === after) break;
      after = page.nextCursor;
    }

    await this.db.syncState.put({ resource: name, cursor: stored, lastPullAt: this.runtime.now() });
    this.workLocally();
    this._pulledResources.update((pulled) => new Set(pulled).add(name));
  }
}
