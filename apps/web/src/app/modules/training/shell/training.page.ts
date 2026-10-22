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
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { GearIcon } from '../../../core/layout/gear-icon';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { InstallHintService } from '../../../core/pwa/install-hint.service';
import { SessionState } from '../../../core/session/session-state';
import { SessionRepository } from '../data/sessions/session-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { TrainingSyncLine } from './training-sync-line';

function isWithin(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
}

/**
 * Casca do módulo Treino: cabeçalho com data e estado de sincronização, detalhes expansíveis e a tela da aba. Os dados do
 * módulo (`provideTrainingData`) vêm do escopo da conta (`TrainingAccountScope`), que recria tudo quando a conta muda; ao
 * entrar, o puxador é ligado (uma vez) e o que o
 * servidor tem de novo chega ao banco local sem a tela esperar por ele. A folha das alterações recusadas só existe
 * enquanto a pessoa a pede, e só se há o que mostrar.
 *
 * Também sabe quando há um treino aberto neste aparelho (relê a cada gravação) e, enquanto houver, pede que a folha
 * "Atalho na tela de início" não abra sozinha: um aviso no meio de uma série atrapalha mais que ajuda, e um treino
 * restaurado ao abrir o app seria interrompido 3 s depois. Os detalhes de sincronização também deixam de sugerir a instalação.
 */
@Component({
  selector: 'app-training-page',
  imports: [RouterLink, RouterOutlet, TrainingSyncLine, SyncIssuesSheet, GearIcon],
  template: `
    <header class="training-header">
      <div class="header-leading">
        @if (backLink(); as link) {
          <a class="back ui-tap" [routerLink]="link" [attr.aria-label]="backLabel()">←</a>
        }
        <button
          type="button"
          class="status ui-tap"
          [class.offline]="!online()"
          [class.failed]="failed() > 0"
          [class.pending]="pending() > 0 || busy()"
          [attr.aria-expanded]="statusOpen()"
          [attr.aria-controls]="'training-sync-details'"
          (click)="statusOpen.update((open) => !open)"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path [attr.d]="'M20 7v5h-5M4 17v-5h5'" />
            <path [attr.d]="'M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2'" />
          </svg>
          <span class="state" aria-hidden="true"></span>
          <span class="ui-visually-hidden">{{ statusLabel() }}</span>
        </button>
      </div>
      <h1 i18n="@@training.shell.title">UniOver Treino</h1>
      @if (isGuest()) {
        <a
          routerLink="/ajustes"
          class="settings ui-tap"
          aria-label="Ajustes"
          i18n-aria-label="@@shell.settings-label"
          ><app-gear-icon
        /></a>
      }
    </header>
    @if (statusOpen()) {
      <section
        id="training-sync-details"
        class="sync-details"
        aria-label="Sincronização"
        i18n-aria-label="@@training.shell.sync-details"
      >
        <span class="detail-date">{{ date }}</span>
        <app-training-sync-line [live]="live()" (issues)="issuesOpen.set(true)" />
        <button
          type="button"
          class="close ui-tap"
          (click)="statusOpen.set(false)"
          i18n="@@training.shell.close-sync"
        >
          Fechar
        </button>
      </section>
    }
    @if (progressArea()) {
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
    <router-outlet (activate)="animateRoute()" />
    @if (issuesOpen()) {
      <app-sync-issues-sheet (closed)="issuesOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .training-header {
      display: grid;
      grid-template-columns: minmax(44px, 1fr) auto minmax(44px, 1fr);
      align-items: center;
      gap: var(--space-1);
      min-height: 56px;
      padding: calc(var(--space-1) + env(safe-area-inset-top)) var(--gutter) var(--space-1);
      border-bottom: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    h1 {
      margin: 0;
      font-size: 1.15rem;
      text-align: center;
      white-space: nowrap;
    }
    .header-leading {
      display: flex;
      align-items: center;
      justify-self: start;
    }
    .back,
    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--tap);
      border: 0;
      background: transparent;
      color: var(--a-ink);
      text-decoration: none;
    }
    .back {
      min-width: var(--tap);
      font-size: 1.4rem;
    }
    .settings {
      display: grid;
      flex: none;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      color: var(--a-ink);
      justify-self: end;
    }
    .status {
      position: relative;
      width: var(--tap);
      padding: 0;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .status svg {
      width: 23px;
      height: 23px;
    }
    .state {
      position: absolute;
      right: 5px;
      bottom: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a-ok-ink);
      box-shadow: 0 0 0 2px var(--a-surface);
    }
    .offline .state,
    .pending .state {
      background: var(--a-warn-ink);
    }
    .failed .state {
      background: var(--a-bad-ink);
    }
    .sync-details {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-1) var(--space-2);
      padding-inline: var(--gutter);
    }
    .detail-date {
      grid-column: 1 / -1;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .sync-details app-training-sync-line {
      flex: 1;
      min-width: 0;
    }
    .close {
      border: 0;
      background: transparent;
      color: var(--a-accent-ink);
      font: inherit;
      cursor: pointer;
    }
    .progress-nav {
      display: flex;
      gap: var(--space-1);
      margin-inline: var(--gutter);
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
    @media (max-width: 450px) {
      .training-header {
        padding-inline: var(--space-2);
      }
      h1 {
        font-size: 1rem;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingPage {
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly session = inject(SessionState);
  private readonly connectivity = inject(ConnectivityService);
  private readonly queue = inject(OfflineQueue);
  private readonly sync = inject(TrainingSync);
  private readonly sessions = inject(SessionRepository);
  private readonly install = inject(InstallHintService);

  protected readonly issuesOpen = signal(false);
  protected readonly statusOpen = signal(false);
  protected readonly online = this.connectivity.online;
  protected readonly isGuest = this.session.isGuest;
  protected readonly failed = this.queue.failedCount;
  protected readonly pending = this.queue.pendingCount;
  protected readonly busy = computed(() => this.queue.syncing() || this.sync.pulling());
  protected readonly date = new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
  }).format(new Date());
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
  protected readonly backLink = computed(() => {
    if (this.session.role() === 'owner') return '/';
    return this.session.role() === 'guest' && this.session.knownPermissions()?.includes('module:tv')
      ? '/tv'
      : null;
  });
  protected readonly backLabel = computed(() =>
    this.backLink() === '/tv'
      ? $localize`:@@training.shell.back-tv:Voltar à TV`
      : $localize`:@@training.shell.back-home:Voltar ao Início`,
  );
  protected readonly statusLabel = computed(() => {
    if (this.failed() > 0)
      return $localize`:@@training.shell.sync-failed:Falhas de sincronização. Toque para ver detalhes.`;
    if (!this.online() || this.sync.error() !== null)
      return $localize`:@@training.shell.sync-offline:Sem sincronização. Toque para ver detalhes.`;
    if (this.pending() > 0 || this.busy())
      return $localize`:@@training.shell.sync-pending:Sincronização em andamento. Toque para ver detalhes.`;
    return $localize`:@@training.shell.sync-ok:Sincronização em dia. Toque para ver detalhes.`;
  });
  private lastArea: number | null = null;
  private lastPath: string | null = null;
  /** Há um treino aberto neste aparelho. */
  protected readonly live = signal(false);

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
    void inject(TrainingSync).start();

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
