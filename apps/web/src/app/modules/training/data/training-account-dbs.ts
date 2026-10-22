import { Injectable, Signal, effect, inject, signal, untracked } from '@angular/core';
import { AccountScope } from '../../../core/session/account-scope';
import { DB_CLOSE_GRACE_MS } from '../../../core/session/db-close';
import { LEGACY_DB_OPENER, adoptWhenDue } from '../../../core/session/legacy-adoption';
import {
  TRAINING_DB_FACTORY,
  TRAINING_DB_NAME,
  TRAINING_TABLES,
  TrainingDb,
  trainingDbName,
} from './training-db';

/** O banco do Treino de uma conta, aberto, e o que falta para ele estar pronto para uso. */
export interface TrainingAccountDb {
  readonly accountId: string;
  readonly db: TrainingDb;
  /** O banco antigo (sem conta), se era a vez desta conta, já foi adotado. Verdadeiro de saída para quem não adota. */
  readonly isReady: Signal<boolean>;
  /** O mesmo, como promessa (nunca rejeita: uma adoção que falha recomeça na próxima partida). */
  readonly ready: Promise<void>;
}

interface Lease extends TrainingAccountDb {
  refs: number;
  superseded: boolean;
  closed: boolean;
}

/**
 * Um banco do Treino aberto por vez: o da conta em uso. Quem precisa dele (a árvore de telas do módulo, a leitura dos
 * créditos) o pede por conta com `lease` e o devolve com `release`; pedir o de OUTRA conta tira o anterior de cena, e o
 * banco anterior é fechado assim que ninguém mais o usa (nunca debaixo de uma leitura em andamento). Dois bancos de contas
 * diferentes nunca ficam abertos para uso ao mesmo tempo, e duas aberturas do mesmo banco nunca existem na aba.
 *
 * A conta dona dos dados antigos (a primeira confirmada no aparelho) os adota aqui, antes de o banco ser usado: copia as
 * linhas do banco `uniover-training`, confere e marca o antigo como adotado, sem apagá-lo.
 */
@Injectable({ providedIn: 'root' })
export class TrainingAccountDbs {
  private readonly account = inject(AccountScope);
  private readonly factory = inject(TRAINING_DB_FACTORY);
  private readonly openLegacy = inject(LEGACY_DB_OPENER);
  private readonly closeGrace = inject(DB_CLOSE_GRACE_MS);

  private current: Lease | null = null;

  constructor() {
    // Saiu da conta (ou nenhuma é conhecida): o banco da conta anterior não fica aberto à toa.
    effect(() => {
      if (this.account.id() === null) untracked(() => this.drop());
    });
  }

  /** O banco da conta, aberto na primeira vez e reaproveitado depois. Não conta como uso (ver `lease`). */
  ensure(accountId: string): TrainingAccountDb {
    if (this.current?.accountId === accountId) return this.current;

    const previous = this.current;
    const db = this.factory(trainingDbName(accountId));
    const isReady = signal(false);
    const adoption = adoptWhenDue(this.account, {
      legacyName: TRAINING_DB_NAME,
      accountId,
      target: db,
      tables: TRAINING_TABLES,
      openLegacy: this.openLegacy,
    });
    let ready: Promise<void>;
    if (adoption) {
      ready = adoption.then(() => isReady.set(true));
    } else {
      // Nada a adotar (não é a dona, ou a adoção já terminou): o banco está pronto na hora, sem quadro de espera.
      isReady.set(true);
      ready = Promise.resolve();
    }

    const lease: Lease = {
      accountId,
      db,
      isReady: isReady.asReadonly(),
      ready,
      refs: 0,
      superseded: false,
      closed: false,
    };
    this.current = lease;
    if (previous) this.retire(previous);
    return lease;
  }

  /** Pega o banco da conta para usar; cada `lease` pede um `release` quando quem o pegou terminar. */
  lease(accountId: string): TrainingAccountDb {
    const handle = this.ensure(accountId) as Lease;
    handle.refs++;
    return handle;
  }

  release(handle: TrainingAccountDb): void {
    const lease = handle as Lease;
    lease.refs = Math.max(0, lease.refs - 1);
    this.closeIfUnused(lease);
  }

  private drop(): void {
    const previous = this.current;
    this.current = null;
    if (previous) this.retire(previous);
  }

  private retire(lease: Lease): void {
    lease.superseded = true;
    this.closeIfUnused(lease);
  }

  private closeIfUnused(lease: Lease): void {
    if (!lease.superseded || lease.refs > 0 || lease.closed) return;
    lease.closed = true;
    // Com uma folga: quem estava lendo quando a tela saiu termina o que começou (ver `DB_CLOSE_GRACE_MS`).
    if (this.closeGrace <= 0) lease.db.close();
    else setTimeout(() => lease.db.close(), this.closeGrace);
  }
}
