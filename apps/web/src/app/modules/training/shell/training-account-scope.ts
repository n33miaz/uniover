import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { QUEUE_BOUND_ACCOUNT } from '../../../core/offline-queue/queue-account';
import { AccountScope } from '../../../core/session/account-scope';
import { TrainingAccountDbs } from '../data/training-account-dbs';
import { provideTrainingData } from '../data/training-data.providers';
import { TRAINING_DB } from '../data/training-db';
import { TrainingPage } from './training.page';

/** A conta dona de uma árvore de telas do Treino (o banco, a fila e todos os dados dela são desta conta e de mais nenhuma). */
export const TRAINING_ACCOUNT = new InjectionToken<string>('TRAINING_ACCOUNT');

/**
 * Tudo o que o módulo guarda de UMA conta, entregue a quem estiver dentro dele: o banco local dela, a fila de escrita
 * amarrada a ela e a camada de dados (repositórios, puxador, estados em memória). Vive e morre com o elemento que o leva:
 * quando a conta muda, o escopo é recriado e nada da conta anterior (sinais, caches, o puxador) sobra para a seguinte.
 * Fica num componente e não nos `providers` da rota porque o injetor de uma rota é guardado para sempre e não acompanha a
 * troca de conta.
 */
@Directive({
  selector: '[appTrainingAccountData]',
  providers: [
    {
      provide: TRAINING_ACCOUNT,
      useFactory: () => {
        const id = inject(AccountScope).id();
        if (id === null) throw new Error('O Treino só abre com uma conta conhecida.');
        return id;
      },
    },
    { provide: QUEUE_BOUND_ACCOUNT, useExisting: TRAINING_ACCOUNT },
    // Outra instância da fachada da fila, amarrada à conta deste escopo (a da raiz segue a conta do aparelho).
    OfflineQueue,
    {
      provide: TRAINING_DB,
      useFactory: () => {
        const dbs = inject(TrainingAccountDbs);
        const lease = dbs.lease(inject(TRAINING_ACCOUNT));
        inject(DestroyRef).onDestroy(() => dbs.release(lease));
        return lease.db;
      },
    },
    provideTrainingData(),
  ],
})
export class TrainingAccountData {}

/**
 * Entrada do módulo Treino: só mostra as telas quando se sabe de quem é o banco local e ele está pronto, e as recria
 * quando a conta muda (sem recarregar a página).
 *
 * Sem conta conhecida (aparelho sem dica da última conta e `/me` ainda por chegar, como no primeiro uso sem rede) NENHUM
 * banco é aberto e nada é lido nem gravado: aparece só o aviso de que a conta está sendo confirmada, e as telas surgem
 * quando ela for conhecida. Nunca se cria dado num banco "sem dono".
 */
@Component({
  selector: 'app-training-account-scope',
  imports: [TrainingAccountData, TrainingPage],
  template: `
    @for (account of scopes(); track account) {
      <ng-container appTrainingAccountData>
        <app-training-page />
      </ng-container>
    } @empty {
      <p class="ui-notice" role="status" i18n="@@training.account.entering">
        Confirmando a sua conta…
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingAccountScope {
  private readonly account = inject(AccountScope);
  private readonly dbs = inject(TrainingAccountDbs);

  /** A conta cujo banco já está pronto (a adoção do banco antigo, se era a vez dela, já terminou). */
  private readonly readyFor = signal<string | null>(null);

  /** Uma conta quando há uma e o banco dela está pronto; zero caso contrário. Trocar de conta troca o item e recria tudo. */
  protected readonly scopes = computed<readonly string[]>(() => {
    const id = this.account.id();
    return id !== null && this.readyFor() === id ? [id] : [];
  });

  constructor() {
    // Já na criação (e não só no efeito): quem tem o banco pronto não passa nem por um quadro de espera.
    this.prepare(this.account.id());
    effect(() => {
      const id = this.account.id();
      this.account.legacyDecided();
      untracked(() => this.prepare(id));
    });
  }

  /** Abre o banco da conta (o da conta anterior sai de cena) e espera a adoção do antigo, se houver. */
  private prepare(id: string | null): void {
    if (id === null) {
      this.readyFor.set(null);
      return;
    }
    const handle = this.dbs.ensure(id);
    if (handle.isReady()) {
      this.readyFor.set(id);
      return;
    }
    this.readyFor.set(null);
    void handle.ready.then(() => {
      if (this.account.id() === id) this.readyFor.set(id);
    });
  }
}
