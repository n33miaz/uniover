import {
  DestroyRef,
  EnvironmentInjector,
  Injectable,
  createEnvironmentInjector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AccountScope } from '../session/account-scope';
import { DB_CLOSE_GRACE_MS, waitGrace } from '../session/db-close';
import { LEGACY_DB_OPENER, adoptWhenDue } from '../session/legacy-adoption';
import { DATABASE_NAME, OFFLINE_DB, OFFLINE_DB_FACTORY, offlineDbName } from './offline-db';
import { OutboxStore } from './outbox-store';
import { AccountQueue, QUEUE_ACCOUNT, QUEUE_READY } from './queue-account';
import { SyncEngine } from './sync-engine';

/**
 * A fila de escrita offline separada por conta. Existe no máximo UMA fila aberta (a da conta em uso); trocar de conta
 * fecha a anterior (sem apagar nada do disco) e abre a nova.
 *
 * Cada fila é um injetor próprio com o banco da conta, a loja sobre ele e o motor de envio: sinais, temporizadores, o
 * "primeiro envio" e as passagens em andamento são dela e morrem com ela, então nada da conta anterior sobra para a
 * seguinte. Os itens ainda não enviados de uma conta ficam no banco dela até ela voltar a entrar (nunca são descartados,
 * nem enviados com outro token).
 *
 * Sem conta conhecida (aparelho sem dica e sem `/me`) NÃO há fila nenhuma: nada é aberto nem gravado num banco "sem dono".
 */
@Injectable({ providedIn: 'root' })
export class QueueScopes {
  private readonly account = inject(AccountScope);
  private readonly parent = inject(EnvironmentInjector);
  private readonly dbFactory = inject(OFFLINE_DB_FACTORY);
  private readonly openLegacy = inject(LEGACY_DB_OPENER);
  private readonly closeGrace = inject(DB_CLOSE_GRACE_MS);

  private readonly _active = signal<AccountQueue | null>(null);
  /** A fila da conta em uso (leitura reativa; só `sync()` a troca). */
  readonly active = this._active.asReadonly();

  private following = false;
  private readonly retiring = new Set<Promise<void>>();
  private readonly adopting = new Set<AccountQueue>();

  constructor() {
    // O injetor de uma fila é filho do da raiz mas NÃO morre com ele: sem isto o motor da conta em uso seguiria com os
    // ouvintes de `online` e de visibilidade da página depois de a raiz acabar (o teste reinicia a raiz com o mesmo
    // documento). O banco não é fechado aqui: quem abriu o banco decide.
    inject(DestroyRef).onDestroy(() => {
      const active = untracked(this._active);
      if (active) {
        void active.engine.stop();
        active.injector.destroy();
      }
    });
  }

  /**
   * Alinha a fila aberta com a conta atual do aparelho e devolve a fila dela (ou `null` sem conta). Síncrono: quem vai gravar
   * ou ler chama isto primeiro, então nunca usa a fila da conta anterior.
   */
  sync(): AccountQueue | null {
    const id = this.account.id();
    const current = untracked(this._active);
    if (
      (current?.accountId ?? null) === id &&
      (id === null ||
        (current !== null && this.adopting.has(current)) ||
        !this.account.shouldAdopt(DATABASE_NAME, id))
    ) {
      return current;
    }

    if (current) this.retire(current);
    const next = id === null ? null : this.open(id);
    this._active.set(next);
    return next;
  }

  /**
   * Liga o aparelho à fila: a da conta atual passa a ser aberta e iniciada agora e, de agora em diante, a cada troca de conta
   * (a partida do app chama isto; sem isso o que ficou pendente não seria reenviado num aparelho aberto sem nenhuma escrita
   * nova). Idempotente.
   */
  follow(): void {
    if (this.following) return;
    this.following = true;
    void this.sync()?.engine.start();
    effect(
      () => {
        this.account.id();
        this.account.legacyDecided();
        untracked(() => void this.sync()?.engine.start());
      },
      { injector: this.parent },
    );
  }

  /** Resolve quando toda fila que saiu de cena já foi encerrada e o banco dela fechado. */
  retired(): Promise<void> {
    return Promise.all([...this.retiring]).then(() => undefined);
  }

  private open(accountId: string): AccountQueue {
    const db = this.dbFactory(offlineDbName(accountId));
    // A conta que adota os bancos antigos o faz antes de qualquer leitura ou envio (o motor e a fachada esperam isto).
    const adoption = adoptWhenDue(this.account, {
      legacyName: DATABASE_NAME,
      accountId,
      target: db,
      tables: ['outbox', 'meta'],
      openLegacy: this.openLegacy,
    });
    const ready = adoption ? adoption.then(() => undefined) : Promise.resolve();

    const injector = createEnvironmentInjector(
      [
        { provide: QUEUE_ACCOUNT, useValue: accountId },
        { provide: QUEUE_READY, useValue: ready },
        { provide: OFFLINE_DB, useValue: db },
        OutboxStore,
        SyncEngine,
      ],
      this.parent,
      `fila:${accountId}`,
    );
    const queue: AccountQueue = {
      accountId,
      injector,
      db,
      ready,
      store: injector.get(OutboxStore),
      engine: injector.get(SyncEngine),
    };
    if (adoption) {
      this.adopting.add(queue);
      void ready.then(() => this.adopting.delete(queue));
    }
    return queue;
  }

  /**
   * Tira a fila de cena: o motor para de começar coisas, a passagem em andamento termina (um item em voo é concluído no
   * banco antes de ele fechar) e só então o injetor é destruído e, passada uma folga para o que ainda está lendo (ver
   * `DB_CLOSE_GRACE_MS`), o banco é fechado. Nada é apagado do disco.
   */
  private retire(queue: AccountQueue): void {
    const done = (async () => {
      try {
        await queue.engine.stop();
      } finally {
        queue.injector.destroy();
        await waitGrace(this.closeGrace);
        queue.db.close();
      }
    })().catch(() => undefined);
    this.retiring.add(done);
    void done.then(() => this.retiring.delete(done));
  }
}
