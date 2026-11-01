import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { InstallHintService } from '../../../core/pwa/install-hint.service';
import { PageTopBar } from '../../../shared/ui/page-top-bar';
import { SessionRepository } from '../data/sessions/session-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { BackNavigation, injectTrainingBackLabel, trainingParent } from './back-navigation';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { TrainingSyncIndicator } from './training-sync-indicator';
import { TrainingSyncLine } from './training-sync-line';
import { TrainingSyncRing } from './training-sync-ring';
import { TrainingSyncSheet } from './training-sync-sheet';
import { TrainingGlyph } from './training-glyph';
import { type TrainingHeaderAction, TrainingHeaderActions } from './training-header-actions';
import { TrainingSheet } from './training-sheet';

function isWithin(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
}

/**
 * Casca do módulo Treino: barra comum no topo, uma volta e as opções da tela aberta. Os dados do
 * módulo (`provideTrainingData`) vêm do escopo da conta (`TrainingAccountScope`), que recria tudo quando a conta muda; ao
 * entrar, o puxador é ligado (uma vez) e o que o
 * servidor tem de novo chega ao banco local sem a tela esperar por ele. A folha das alterações recusadas só existe
 * enquanto a pessoa a pede, e só se há o que mostrar.
 *
 * Também sabe quando há um treino aberto neste aparelho (relê a cada gravação) e, enquanto houver, pede que a folha
 * "Atalho na tela de início" não abra sozinha: um aviso no meio de uma série atrapalha mais que ajuda, e um treino
 * restaurado ao abrir o app seria interrompido 3 s depois.
 */
@Component({
  selector: 'app-training-page',
  host: { '[attr.data-screen-ready]': "routeMounted() ? 'training' : null" },
  imports: [
    PageTopBar,
    RouterLink,
    RouterOutlet,
    SyncIssuesSheet,
    TrainingGlyph,
    TrainingSheet,
    TrainingSyncLine,
    TrainingSyncRing,
    TrainingSyncSheet,
  ],
  providers: [TrainingSyncIndicator],
  template: `
    <app-page-top-bar [title]="title" [backLabel]="backLabel()" (back)="goBack()">
      @if (syncRing.visible() || menuActions().length > 0) {
        <div
          pageTopBarActions
          class="pill"
          [class.pair]="syncRing.visible() && menuActions().length > 0"
        >
          @if (syncRing.visible()) {
            <app-training-sync-ring />
          }
          @if (menuActions().length > 0) {
            <button
              type="button"
              class="more"
              [attr.aria-haspopup]="'dialog'"
              aria-label="Mais opções"
              i18n-aria-label="@@training.shell.more-options"
              (click)="menuOpen.set(true)"
            >
              •••
            </button>
          }
        </div>
      }
    </app-page-top-bar>
    <div class="content">
      <app-training-sync-line [live]="live()" />
      @if (progressArea() && !bodyArea()) {
        <nav
          class="progress-nav"
          aria-label="Seções de progresso"
          i18n-aria-label="@@training.shell.progress-sections"
        >
          <a
            routerLink="/treino/progresso"
            [attr.aria-current]="!bodyArea() ? 'page' : null"
            i18n="@@training.shell.training-progress"
            >Treinos</a
          >
          <a
            routerLink="/treino/corpo"
            [attr.aria-current]="bodyArea() ? 'page' : null"
            i18n="@@training.shell.body-progress"
            >Corpo</a
          >
        </nav>
      }
      <router-outlet (activate)="routeMounted.set(true); animateRoute()" />
    </div>
    @if (syncRing.sheetOpen()) {
      <app-training-sync-sheet
        (closed)="syncRing.sheetOpen.set(false)"
        (issues)="syncRing.sheetOpen.set(false); issuesOpen.set(true)"
      />
    }
    @if (issuesOpen()) {
      <app-sync-issues-sheet (closed)="issuesOpen.set(false)" />
    }
    @if (menuOpen()) {
      <app-training-sheet [heading]="menuHeading" (closed)="menuOpen.set(false)">
        <ul class="menu-actions ui-group ui-plain">
          @for (action of menuActions(); track action.id) {
            <li>
              <button type="button" class="ui-row" (click)="runMenuAction(action)">
                <span class="ui-row-text"
                  ><span class="ui-row-title">{{ action.label }}</span></span
                >
                <app-training-glyph name="next" />
              </button>
            </li>
          }
        </ul>
      </app-training-sheet>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      -webkit-tap-highlight-color: transparent;
    }
    app-page-top-bar {
      position: sticky;
      top: 0;
      z-index: 5;
      /* O mesmo fundo da tela (sem faixa nem borda): opaco só para o conteúdo que rola não passar por baixo do título. */
      background: var(--a-bg);
    }
    /* A pílula do topo: o anel de sincronização (quando à vista) e os três pontos, cada um com o próprio alvo de toque. */
    .more {
      display: grid;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      padding: 0 0 4px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--a-ink);
      font: 700 1rem/1 sans-serif;
      letter-spacing: 1px;
      cursor: pointer;
      touch-action: manipulation;
    }
    .more:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: -3px;
    }
    /*
     * O que fica abaixo do cabeçalho mantém o respiro lateral e inferior que o <main> dava às outras telas. Em cima a casca
     * não soma espaço: cada tela já abre com o seu (12 px) e o cabeçalho acrescenta uma folga fixa embaixo; somar mais um
     * respiro aqui deixaria uns 40 px de vão sob o cabeçalho. Tela nova do módulo abre com 12 px, sem margem negativa.
     */
    .content {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-3);
      padding: 0 max(var(--gutter), env(safe-area-inset-right))
        calc(var(--gutter) + var(--safe-bottom)) max(var(--gutter), env(safe-area-inset-left));
    }
    .progress-nav {
      margin-top: var(--space-3);
      display: flex;
      gap: var(--space-1);
      padding: 3px;
      border-radius: var(--radius-sm);
      background: var(--a-elev);
    }
    .progress-nav a {
      flex: 1;
      min-height: var(--tap);
      display: grid;
      place-items: center;
      border-radius: var(--radius-sm);
      color: var(--a-ink2);
      font-weight: 700;
      text-decoration: none;
    }
    .progress-nav a[aria-current] {
      background: var(--a-surface);
      color: var(--a-accent-ink);
      box-shadow: var(--shadow-1);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingPage {
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sync = inject(TrainingSync);
  private readonly sessions = inject(SessionRepository);
  private readonly install = inject(InstallHintService);
  private readonly navigation = inject(BackNavigation);
  private readonly headerActions = inject(TrainingHeaderActions);

  protected readonly syncRing = inject(TrainingSyncIndicator);
  protected readonly issuesOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly routeMounted = signal(false);
  protected readonly title = $localize`:@@training.shell.title:Treino`;
  protected readonly menuHeading = $localize`:@@training.shell.more-heading:Opções`;
  /**
   * A seta existe em toda tela, com uma exceção: quem só tem o Treino e o abriu pelo app instalado não tem para onde ir
   * a partir de uma aba (a Início fica fora do escopo `/treino/`, e o iOS o tiraria do app); para ele o Treino é o app
   * inteiro e a raiz das abas fica sem seta. As telas internas voltam ao pai de sempre.
   */
  protected readonly backLabel = injectTrainingBackLabel(
    () => this.url(),
    () => this.headerActions.backHandler() !== null,
  );
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(this.router.url),
    ),
    { requireSync: true },
  );
  protected readonly bodyArea = computed(() =>
    isWithin(this.url().split(/[?#]/)[0].replace(/\/$/, ''), '/treino/corpo'),
  );
  protected readonly progressArea = computed(
    () =>
      this.bodyArea() ||
      isWithin(this.url().split(/[?#]/)[0].replace(/\/$/, ''), '/treino/progresso'),
  );
  private lastArea: number | null = null;
  private lastPath: string | null = null;
  /** Há um treino aberto neste aparelho. */
  protected readonly live = signal(false);

  protected readonly menuActions = computed<readonly TrainingHeaderAction[]>(() => {
    return [...this.headerActions.actions()];
  });

  protected goBack(): void {
    const handler = this.headerActions.backHandler();
    if (handler !== null) {
      handler();
      return;
    }
    const parent = trainingParent(this.url());
    if (parent === null) void this.router.navigateByUrl('/');
    else this.navigation.back(parent);
  }

  protected runMenuAction(action: TrainingHeaderAction): void {
    this.menuOpen.set(false);
    action.run();
  }

  protected animateRoute(): void {
    const path = this.router.url.split(/[?#]/)[0];
    const previousPath = this.lastPath;
    this.lastPath = path;
    const area =
      path.startsWith('/treino/exercicios') || path.startsWith('/treino/rotinas')
        ? 0
        : path.startsWith('/treino/corpo')
          ? 3
          : path.startsWith('/treino/progresso')
            ? 2
            : 1;
    const previous = this.lastArea;
    this.lastArea = area;
    const previousExercisePage = this.exercisePage(previousPath);
    const nextExercisePage = this.exercisePage(path);
    const switchingExercisePage = previousExercisePage !== null && nextExercisePage !== null;
    if (!switchingExercisePage && (previous === null || previous === area || previousPath === null))
      return;
    const page = this.host.nativeElement.querySelector('router-outlet + *');
    if (!page) return;

    // A rota remove o link que iniciou a navegação. Devolve o foco ao seletor equivalente da tela nova.
    if (switchingExercisePage && document.activeElement === document.body) {
      page
        .querySelector<HTMLElement>('.seg a[aria-current="page"]')
        ?.focus({ preventScroll: true });
    }

    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const backwards = switchingExercisePage
      ? previousExercisePage === 'routines'
      : previous! > area;
    page.animate(
      [
        { opacity: 0.65, transform: `translateX(${backwards ? -18 : 18}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  }

  private exercisePage(path: string | null): 'catalog' | 'routines' | null {
    if (path === '/treino/exercicios') return 'catalog';
    if (path === '/treino/rotinas') return 'routines';
    return null;
  }

  constructor() {
    // Sem esperar: o `start()` hidrata a fila e puxa em segundo plano; a tela lê do banco local desde já.
    void this.sync.start();

    // Relê o treino aberto a cada gravação do aparelho (iniciar, série, encerrar, descartar). A resposta mais velha, que
    // chega depois de uma mais nova, é descartada.
    let latest = 0;
    effect(() => {
      this.sessions.revision();
      const turn = ++latest;
      void this.sessions.activeSession().then(
        (active) => {
          if (turn === latest) this.live.set(active !== undefined);
        },
        () => undefined,
      );
    });

    // Treino aberto: a folha de instalação não abre sozinha. Ao encerrar (ou sair do módulo) o pedido é solto.
    effect((onCleanup) => {
      if (!this.live()) return;
      onCleanup(untracked(() => this.install.holdAuto()));
    });
  }
}
