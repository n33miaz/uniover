import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { ProgressPhotoSync } from '../data/photos/progress-photo-sync';
import { TrainingSync } from '../data/sync/training-sync';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { TrainingSyncLine } from './training-sync-line';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function isWithin(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
}

/**
 * Casca do módulo Treino: cabeçalho colado no topo com o estado de sincronização (ícone que atualiza ao toque) e a tela da aba. Os dados do
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
  imports: [RouterLink, RouterOutlet, SyncIssuesSheet, TrainingSyncLine, GearIcon],
  template: `
    <header class="training-header">
      <div class="header-leading">
        @if (backLink(); as link) {
          <a class="back ui-tap" [routerLink]="link" [attr.aria-label]="backLabel">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path [attr.d]="'M19 12H5m7 7-7-7 7-7'" />
            </svg>
          </a>
        }
      </div>
      <h1 i18n="@@training.shell.title">UniOver Treino</h1>
      <div class="header-actions">
        <button
          type="button"
          class="status"
          [attr.data-state]="syncState()"
          [attr.aria-label]="statusLabel()"
          (click)="onStatusTap($event)"
          (animationend)="onRippleEnd($event)"
        >
          <span class="chip" [class.pulse]="pulsing()">
            @if (showSpinner()) {
              <svg
                class="spin"
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                (animationiteration)="onSpinIteration()"
              >
                <path [attr.d]="'M20 7v5h-5M4 17v-5h5'" />
                <path [attr.d]="'M5.64 5.64A9 9 0 0 1 20 12M4 12a9 9 0 0 0 14.36 6.36'" />
              </svg>
            } @else {
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                @switch (syncState()) {
                  @case ('pending') {
                    <path [attr.d]="'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'" />
                    <path [attr.d]="'M12 17v-5m0 0-2.2 2.2M12 12l2.2 2.2'" />
                  }
                  @case ('offline') {
                    <path
                      [attr.d]="'M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3'"
                    />
                    <path [attr.d]="'M2 2l20 20'" />
                  }
                  @case ('failed') {
                    <path
                      [attr.d]="'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01'"
                    />
                  }
                  @default {
                    <path [attr.d]="'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'" />
                    <path [attr.d]="'m9 14.5 2 2 4-4'" />
                  }
                }
              </svg>
            }
            @if (badge(); as count) {
              <span class="count" aria-hidden="true">{{ count }}</span>
            }
          </span>
        </button>
        <a
          routerLink="/ajustes"
          class="settings ui-tap"
          aria-label="Ajustes"
          i18n-aria-label="@@shell.settings-label"
          ><app-gear-icon
        /></a>
      </div>
    </header>
    <span class="ui-visually-hidden" role="status" [attr.aria-live]="'polite'">{{
      announcement()
    }}</span>
    <div class="content">
      <app-training-sync-line [live]="live()" (issues)="issuesOpen.set(true)" />
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
    </div>
    @if (issuesOpen()) {
      <app-sync-issues-sheet (closed)="issuesOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      -webkit-tap-highlight-color: transparent;
    }
    /*
     * O cabeçalho vai de borda a borda e cola no topo (o <main> do Treino não tem padding): quem cuida do entalhe e das
     * laterais é ele. Translúcido sobre o conteúdo que rola por baixo, com fundo opaco de reserva.
     */
    .training-header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: grid;
      grid-template-columns: minmax(88px, 1fr) auto minmax(88px, 1fr);
      align-items: center;
      min-height: calc(52px + env(safe-area-inset-top));
      padding: env(safe-area-inset-top) max(var(--gutter), env(safe-area-inset-right)) 0
        max(var(--gutter), env(safe-area-inset-left));
      border-bottom: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
      .training-header {
        background: color-mix(in srgb, var(--a-surface) 86%, transparent);
        -webkit-backdrop-filter: blur(12px) saturate(1.4);
        backdrop-filter: blur(12px) saturate(1.4);
      }
    }
    h1 {
      margin: 0;
      font-size: clamp(1.05rem, 4.4vw, 1.2rem);
      font-weight: 700;
      letter-spacing: -0.01em;
      text-align: center;
      white-space: nowrap;
    }
    .header-leading,
    .header-actions {
      display: flex;
      align-items: center;
      min-width: 0;
    }
    .header-actions {
      justify-self: end;
    }
    /* Voltar, sincronizar e Ajustes: a mesma grade de 44 px, o mesmo ícone de 22 px e o mesmo traço. */
    .back,
    .status,
    .settings {
      display: inline-grid;
      flex: none;
      place-items: center;
      min-width: var(--tap);
      height: var(--tap);
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--a-ink);
      text-decoration: none;
    }
    .back,
    .settings {
      width: var(--tap);
    }
    .back svg {
      width: 22px;
      height: 22px;
    }
    .status {
      position: relative;
      font: inherit;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .status:focus-visible {
      border-radius: 50%;
      outline: 3px solid var(--a-accent);
      outline-offset: -2px;
    }
    /* O estado vive numa pastilha pequena dentro do alvo de 44 px: em dia é só um ícone verde; o resto ganha fundo. */
    .status .chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-width: 32px;
      height: 32px;
      padding: 0 6px;
      border-radius: var(--radius-pill);
      color: var(--a-ok-ink);
      font-size: var(--fs-label);
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      transition:
        background-color var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out),
        scale var(--dur-fast) var(--ease-out);
    }
    .status svg {
      width: 20px;
      height: 20px;
    }
    .count {
      padding-right: 2px;
    }
    .status:active .chip {
      scale: 0.92;
    }
    .status[data-state='busy'] .chip {
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
    }
    .status[data-state='pending'] .chip {
      background: var(--a-warn-soft);
      color: var(--a-warn-ink);
    }
    .status[data-state='offline'] .chip {
      color: var(--a-ink2);
    }
    .status[data-state='failed'] .chip {
      background: var(--a-bad-soft);
      color: var(--a-bad-ink);
    }
    /* Uma volta por 0,9 s; o movimento só é solto no fim de uma volta, para parar em 0 sem salto. */
    .status svg.spin {
      animation: sync-spin 900ms linear infinite;
    }
    @keyframes sync-spin {
      to {
        rotate: 360deg;
      }
    }
    /* O anel do toque: sai do centro e some. A classe é posta (e solta) pelo componente a cada toque. */
    .status::before {
      content: '';
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--a-accent) 22%, transparent);
      opacity: 0;
      pointer-events: none;
    }
    .status.ripple::before {
      animation: sync-ripple 420ms var(--ease-out);
    }
    @keyframes sync-ripple {
      from {
        opacity: 1;
        scale: 0.3;
      }
      to {
        opacity: 0;
        scale: 1.15;
      }
    }
    .chip.pulse {
      animation: sync-pulse 500ms var(--ease-out);
    }
    @keyframes sync-pulse {
      40% {
        scale: 1.18;
      }
    }
    /* O que fica abaixo do cabeçalho mantém o respiro lateral e inferior que o <main> dava às outras telas. */
    .content {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-3) max(var(--gutter), env(safe-area-inset-right))
        calc(var(--gutter) + env(safe-area-inset-bottom))
        max(var(--gutter), env(safe-area-inset-left));
    }
    .progress-nav {
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
    @media (prefers-reduced-motion: reduce) {
      .status .chip {
        transition: none;
      }
      .status svg.spin,
      .status.ripple::before,
      .chip.pulse {
        animation: none;
      }
      .status:active .chip {
        scale: 1;
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
  private readonly photoSync = inject(ProgressPhotoSync);
  private readonly sessions = inject(SessionRepository);
  private readonly install = inject(InstallHintService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly issuesOpen = signal(false);
  /** Toque manual em andamento: dura até o puxar acabar E a volta mínima do ícone terminar. */
  protected readonly manualPull = signal(false);
  protected readonly manualError = signal(false);
  protected readonly spinning = signal(false);
  protected readonly pulsing = signal(false);
  protected readonly announcement = signal('');
  protected readonly online = this.connectivity.online;
  protected readonly failed = this.queue.failedCount;
  protected readonly pending = this.queue.pendingCount;
  protected readonly busy = computed(
    () => this.queue.syncing() || this.sync.pulling() || this.manualPull(),
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
  /** Telas internas trazem o próprio voltar (um só) para o pai lógico; a seta da casca não pode duplicá-lo. */
  private readonly innerScreen = computed(() => {
    const path = this.url().split(/[?#]/)[0];
    return (
      /^\/treino\/(sessao(?:\/|$)|corpo\/avaliacoes(?:\/|$)|exercicios\/[^/]+|rotinas\/[^/]+)/.test(
        path,
      ) || path === '/treino/glossario'
    );
  });
  protected readonly progressArea = computed(
    () =>
      this.bodyArea() ||
      isWithin(this.url().split(/[?#]/)[0].replace(/\/$/, ''), '/treino/progresso'),
  );
  /**
   * Só o dono volta ao Início daqui. O convidado nunca vê a seta, nem com a TV liberada: ele abre o Treino e a TV pelos
   * ícones próprios da tela inicial do celular, e o Treino é um app dele (o controle da TV segue alcançável pelos Ajustes).
   */
  protected readonly backLink = computed(() =>
    this.session.role() === 'owner' && !this.innerScreen() ? '/' : null,
  );
  protected readonly backLabel = $localize`:@@training.shell.back-home:Voltar ao Início`;
  /** O instante mais novo entre o último envio aceito e o último puxar completo (só para o rótulo do ícone). */
  private readonly lastSyncAt = computed(() => {
    const latest = Math.max(this.queue.lastSyncAt() ?? 0, this.sync.lastPullAt() ?? 0);
    return latest > 0 ? latest : null;
  });
  /** Uma só palavra de estado para o ícone: cor, ponto e movimento saem dela. */
  protected readonly syncState = computed<'ok' | 'busy' | 'pending' | 'offline' | 'failed'>(() => {
    if (this.failed() > 0) return 'failed';
    if (this.busy()) return 'busy';
    if (!this.online()) return 'offline';
    if (this.manualError() || this.sync.error() !== null) return 'failed';
    if (this.pending() > 0) return 'pending';
    return 'ok';
  });
  /** O ícone que gira fica à vista enquanto sincroniza e até o fim da volta em curso, para parar em 0 sem salto. */
  protected readonly showSpinner = computed(() => this.syncState() === 'busy' || this.spinning());
  /** A contagem ao lado do ícone: o que espera envio, ou o que o servidor recusou. Nada em dia. */
  protected readonly badge = computed(() => {
    const count =
      this.syncState() === 'pending'
        ? this.pending()
        : this.syncState() === 'failed'
          ? this.failed()
          : 0;
    return count === 0 ? null : count > 9 ? '9+' : String(count);
  });
  /** Sem texto à vista: o rótulo do botão diz o estado e o que o toque faz. */
  protected readonly statusLabel = computed(() => {
    switch (this.syncState()) {
      case 'failed': {
        const count = this.failed();
        if (count === 0) {
          return $localize`:@@training.shell.sync-error:Falha ao atualizar. Toque para tentar de novo.`;
        }
        return count === 1
          ? $localize`:@@training.shell.sync-failed-one:1 alteração com erro. Toque para ver e tentar de novo.`
          : $localize`:@@training.shell.sync-failed-many:${count}:count: alterações com erro. Toque para ver e tentar de novo.`;
      }
      case 'busy':
        return $localize`:@@training.shell.sync-pending:Sincronizando.`;
      case 'offline':
        return $localize`:@@training.shell.sync-offline:Sem rede. Toque para tentar de novo.`;
      case 'pending': {
        const count = this.pending();
        return count === 1
          ? $localize`:@@training.shell.sync-waiting-one:1 alteração aguardando envio. Toque para sincronizar.`
          : $localize`:@@training.shell.sync-waiting:${count}:count: alterações aguardando envio. Toque para sincronizar.`;
      }
      default: {
        const at = this.lastSyncAt();
        return at === null
          ? $localize`:@@training.shell.sync-ok:Sincronização em dia. Toque para atualizar.`
          : $localize`:@@training.shell.sync-ok-at:Sincronizado às ${timeFormat.format(at)}:time:. Toque para atualizar.`;
      }
    }
  });
  private lastArea: number | null = null;
  private lastPath: string | null = null;
  private pulseTimer: number | undefined;
  private holdTimer: number | undefined;
  private releaseHold: (() => void) | undefined;
  private destroyed = false;
  /** Há um treino aberto neste aparelho. */
  protected readonly live = signal(false);

  /** O toque sempre responde com o anel; depois, com falhas abre a lista delas e, nos demais estados, atualiza. */
  protected onStatusTap(event: Event): void {
    const button = event.currentTarget as HTMLElement;
    // Reinicia a animação do anel mesmo com toques seguidos.
    button.classList.remove('ripple');
    void button.offsetWidth;
    button.classList.add('ripple');
    if (this.failed() > 0) {
      this.issuesOpen.set(true);
      return;
    }
    void this.syncNow();
  }

  /** O anel acabou: solta a classe para o próximo toque. */
  protected onRippleEnd(event: AnimationEvent): void {
    if (event.animationName === 'sync-ripple')
      (event.currentTarget as HTMLElement).classList.remove('ripple');
  }

  /** Fim de uma volta do ícone (ele está em 0 graus): se nada mais pede movimento, solta sem salto. */
  protected onSpinIteration(): void {
    if (!this.busy()) this.spinning.set(false);
  }

  /**
   * Puxa o que o servidor tem de novo, sem texto à vista. O toque dura ao menos uma volta do ícone, mesmo que o puxar
   * acabe antes, para a resposta ser sempre visível; o resultado vai para a região de leitura de tela.
   */
  protected async syncNow(): Promise<void> {
    if (this.manualPull()) return;
    this.announcement.set('');
    if (!this.online()) {
      // Sem rede o toque ainda tenta esvaziar a fila (o envio forçado não espera o recuo): se a rede voltou sem aviso, sobe.
      void this.queue.syncNow().catch(() => undefined);
      this.announcement.set(
        $localize`:@@training.shell.announce-offline:Sem rede. Os dados salvos no aparelho continuam disponíveis.`,
      );
      return;
    }
    this.manualError.set(false);
    this.manualPull.set(true);
    const minimum = new Promise<void>((resolve) => {
      this.releaseHold = resolve;
      this.holdTimer = window.setTimeout(resolve, 700);
    });
    try {
      await Promise.all([this.sync.pullNow(), minimum]);
    } catch {
      this.manualError.set(true);
    }
    if (this.destroyed) return;
    this.manualPull.set(false);
    // Um envio recusado pelo servidor não rejeita o pull: a fila marca o item como falho.
    if (this.manualError() || this.sync.error() !== null || this.failed() > 0) {
      this.announcement.set(
        $localize`:@@training.shell.announce-failed:Falha ao atualizar. Os dados salvos no aparelho continuam disponíveis.`,
      );
      return;
    }
    this.announcement.set($localize`:@@training.shell.announce-ok:Atualizado.`);
    this.pulsing.set(true);
    window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => this.pulsing.set(false), 500);
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
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      window.clearTimeout(this.holdTimer);
      this.releaseHold?.();
      window.clearTimeout(this.pulseTimer);
    });
    // O ícone gira enquanto algo sincroniza; quem o solta é o fim de uma volta (ou, sem movimento, aqui mesmo).
    effect(() => {
      if (this.busy()) this.spinning.set(true);
      else if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
        this.spinning.set(false);
    });
    // Sem esperar: o `start()` hidrata a fila e puxa em segundo plano; a tela lê do banco local desde já.
    void inject(TrainingSync).start();
    this.photoSync.start();

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
