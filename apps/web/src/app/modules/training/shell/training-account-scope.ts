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
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { PageTopBar } from '../../../shared/ui/page-top-bar';
import { BackNavigation, injectTrainingBackLabel, trainingParent } from './back-navigation';
import { TrainingAccountDbs } from '../data/training-account-dbs';
import { provideTrainingData } from '../data/training-data.providers';
import { TRAINING_DB } from '../data/training-db';
import {
  AssessmentDetailSkeleton,
  AssessmentsListSkeleton,
} from '../body/assessments/assessment-skeletons';
import { BodySkeleton } from '../body/body-skeleton';
import { BodyMapSkeleton } from '../exercises/body-map/body-map-skeleton';
import { ExerciseDetailSkeleton } from '../exercises/detail/detail-skeleton';
import { FoodDiarySkeleton } from '../foods/food-diary-skeleton';
import { ProgressSkeleton } from '../progress/progress-skeleton';
import { RoutinesListSkeleton } from '../routines/routines-list-skeleton';
import { LiveSessionSkeleton, WorkoutDaySkeleton } from '../today/workout-skeletons';
import { TodaySkeleton } from '../today/today-skeleton';
import { TrainingFormSkeleton } from './training-form-skeleton';
import { TrainingRowsSkeleton } from './training-rows-skeleton';
import { TrainingPage } from './training.page';

/** O atraso do esqueleto compartilhado (`--wait-delay` em styles.css) e quanto a marca de espera sobrevive ao banco pronto. */
const SKELETON_DELAY_MS = 200;
const SETTLE_MS = 1000;

/** A forma de cada tela que o endereço de entrada abre: o esqueleto de espera pelo banco já é o da tela que vem depois. */
type EntryShape =
  | 'today'
  | 'library'
  | 'detail'
  | 'map'
  | 'routines'
  | 'form'
  | 'progress'
  | 'diary'
  | 'body'
  | 'assessments'
  | 'assessment'
  | 'workout-day'
  | 'live'
  | 'rows';

/** Qual tela abre: lê o endereço da navegação em curso (ou o atual) e escolhe a forma, a lista genérica se não souber. */
function entryShapeFor(router: Router): EntryShape {
  const tree = router.getCurrentNavigation()?.finalUrl ?? router.parseUrl(router.url);
  const [module, ...rest] = (tree.root.children['primary']?.segments ?? []).map(
    (part) => part.path,
  );
  if (module !== 'treino') return 'rows';
  const [area, second, third] = rest;
  switch (area) {
    case undefined:
      return 'today';
    case 'sessao':
      return second === 'exercicio' ? 'live' : 'workout-day';
    case 'exercicios':
      if (second === undefined) return 'library';
      if (second === 'mapa') return 'map';
      if (second === 'novo' || third === 'editar') return 'form';
      return 'detail';
    case 'rotinas':
      return second === undefined ? 'routines' : 'form';
    case 'progresso':
      return 'progress';
    case 'alimentacao':
      return 'diary';
    case 'corpo':
      if (second !== 'avaliacoes') return 'body';
      if (third === undefined) return 'assessments';
      return third === 'importar' || third === 'nova' ? 'form' : 'assessment';
    default:
      return 'rows';
  }
}

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
  imports: [
    AssessmentDetailSkeleton,
    AssessmentsListSkeleton,
    BodyMapSkeleton,
    BodySkeleton,
    ExerciseDetailSkeleton,
    FoodDiarySkeleton,
    LiveSessionSkeleton,
    PageTopBar,
    ProgressSkeleton,
    RoutinesListSkeleton,
    TodaySkeleton,
    TrainingAccountData,
    TrainingFormSkeleton,
    TrainingPage,
    TrainingRowsSkeleton,
    WorkoutDaySkeleton,
  ],
  template: `
    @for (account of scopes(); track account) {
      <ng-container appTrainingAccountData>
        <app-training-page />
      </ng-container>
    } @empty {
      <app-page-top-bar [title]="title" [backLabel]="backLabel()" (back)="goBack()" />
      <!-- A casca já tem o topo; o que muda é o corpo: Hoje (o endereço do módulo) ou uma lista, na forma que a tela pronta terá. -->
      <div class="content">
        @switch (shape) {
          @case ('today') {
            <app-today-skeleton [withWeek]="true" [label]="enteringLabel" />
          }
          @case ('library') {
            <app-training-rows-skeleton
              [label]="enteringLabel"
              [rows]="6"
              [thumb]="true"
              [head]="'library'"
            />
          }
          @case ('detail') {
            <app-exercise-detail-skeleton />
          }
          @case ('map') {
            <app-body-map-skeleton [withHead]="true" />
          }
          @case ('routines') {
            <app-routines-list-skeleton [withSwitch]="true" />
          }
          @case ('form') {
            <app-training-form-skeleton [label]="enteringLabel" [fields]="3" />
          }
          @case ('progress') {
            <app-progress-skeleton />
          }
          @case ('diary') {
            <app-food-diary-skeleton [page]="true" />
          }
          @case ('body') {
            <app-body-skeleton [withHead]="true" />
          }
          @case ('assessments') {
            <app-assessments-list-skeleton />
          }
          @case ('assessment') {
            <app-assessment-detail-skeleton />
          }
          @case ('workout-day') {
            <app-workout-day-skeleton />
          }
          @case ('live') {
            <app-live-session-skeleton />
          }
          @default {
            <app-training-rows-skeleton [label]="enteringLabel" [rows]="6" />
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
    }
    /* O mesmo respiro lateral e inferior que a casca (training.page) dá ao conteúdo. */
    .content {
      padding: 0 max(var(--gutter), env(safe-area-inset-right))
        calc(var(--gutter) + var(--safe-bottom)) max(var(--gutter), env(safe-area-inset-left));
    }
  `,
  // Depois do atraso desta espera, a do Hoje que vem em seguida já se mostra de uma vez (ver `waited`).
  host: { '[style.--wait-delay]': "waited() ? '0ms' : null" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingAccountScope {
  protected readonly title = $localize`:@@training.shell.title:Treino`;
  protected readonly enteringLabel = $localize`:@@training.account.entering:Confirmando a sua conta…`;
  /** A tela que o endereço de entrada abre: a espera pelo banco já desenha a forma dela. */
  protected readonly shape = entryShapeFor(inject(Router));
  private readonly router = inject(Router);
  private readonly navigation = inject(BackNavigation);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(
        this.router.serializeUrl(
          this.router.getCurrentNavigation()?.finalUrl ?? this.router.parseUrl(this.router.url),
        ),
      ),
    ),
    { requireSync: true },
  );
  /** A mesma seta da casca: o voltar já está no topo enquanto o banco abre. */
  protected readonly backLabel = injectTrainingBackLabel(
    () => this.url(),
    () => false,
  );
  private readonly account = inject(AccountScope);
  private readonly dbs = inject(TrainingAccountDbs);

  /** A conta cujo banco já está pronto (a adoção do banco antigo, se era a vez dela, já terminou). */
  private readonly readyFor = signal<string | null>(null);

  /**
   * A espera pelo banco já passou do atraso em que o esqueleto aparece. Enquanto vale, o esqueleto seguinte (o da tela que
   * abre quando o banco fica pronto) já nasce visível: cada espera só se mostra depois do próprio atraso, e sem isto haveria
   * um vazio entre as duas. A marca cai um pouco depois de o banco ficar pronto.
   */
  protected readonly waited = signal(false);

  /** Uma conta quando há uma e o banco dela está pronto; zero caso contrário. Trocar de conta troca o item e recria tudo. */
  protected readonly scopes = computed<readonly string[]>(() => {
    const id = this.account.id();
    return id !== null && this.readyFor() === id ? [id] : [];
  });

  constructor() {
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        if (this.scopes().length === 0) this.waited.set(true);
      }, SKELETON_DELAY_MS),
    );
    effect(() => {
      if (this.scopes().length > 0) {
        untracked(() => timers.push(setTimeout(() => this.waited.set(false), SETTLE_MS)));
      }
    });
    inject(DestroyRef).onDestroy(() => timers.forEach((timer) => clearTimeout(timer)));
    // Já na criação (e não só no efeito): quem tem o banco pronto não passa nem por um quadro de espera.
    this.prepare(this.account.id());
    effect(() => {
      const id = this.account.id();
      this.account.legacyDecided();
      untracked(() => this.prepare(id));
    });
  }

  protected goBack(): void {
    const parent = trainingParent(this.url());
    if (parent === null) void this.router.navigateByUrl('/');
    else this.navigation.back(parent);
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
