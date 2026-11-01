import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
} from '@angular/router';
import { BootVariant, bootVariantFor } from './boot-variant';
import { PwaUpdateService } from './pwa-update.service';

/** Quanto a primeira tela pode demorar na abertura antes de o esqueleto cobri-la (abaixo disso, a troca é imperceptível). */
export const SLOW_BOOT_MS = 300;
/** Quanto uma navegação dentro do app (download do pedaço da tela, guarda) pode demorar antes de o esqueleto da tela de destino aparecer. */
export const ROUTE_WAIT_MS = 200;
/** Identificador do esqueleto estático do `index.html`, que cobre a tela antes de o Angular subir. */
export const BOOT_SKELETON_ID = 'boot-skeleton';
/** Tempo da saída do esqueleto estático (a animação `leaving` dura `--dur-exit`); passado isso ele é tirado do documento. */
const BOOT_LEAVE_MS = 260;
/** Teto para registrar a demora sem expor a página incompleta por baixo da cobertura. */
export const PAGE_READY_TIMEOUT_MS = 8_000;

/**
 * Cobre a tela inteira com um esqueleto que brilha nos momentos em que, sem ele, só haveria o fundo vazio: do toque em
 * "Atualizar" até o primeiro conteúdo da página nova (a casca nova sobe), na abertura do app quando a primeira tela demora
 * (conexão lenta, servidor acordando: o guarda de entrada espera a sessão antes de mostrar qualquer coisa) e, já dentro do
 * app, quando abrir uma tela demora (o pedaço de código dela ainda está baixando). O desenho é o da tela de destino
 * (`bootVariantFor`): o controle da TV tem o dele, o Treino o dele, Configurações o dele; o genérico é só o último recurso.
 * Na abertura o esqueleto só aparece se a espera passar de `SLOW_BOOT_MS`, para uma abertura rápida não piscar; antes disso
 * quem cobre a tela é o desenho estático do `index.html` (mesmas formas, mesmo CSS global), que este componente retira
 * quando a primeira tela fica pronta.
 * Autocontido: só usa os tokens de cor (`--a-*`) e o brilho único do app (ui-skeleton, em styles.css), que segue os dois
 * temas e, com `prefers-reduced-motion`, vira uma pulsação sem deslocamento (parado, ele pareceria travado). A rota que
 * termina de ativar (ou falha) entrega o primeiro conteúdo; o esqueleto sai pela mesma animação de saída dos avisos. O CSS
 * das formas é global (`boot-skeleton.css`), compartilhado com o desenho estático.
 */
@Component({
  selector: 'app-update-skeleton',
  template: `
    @if (visible()) {
      <div
        class="bs-root"
        role="status"
        [attr.data-boot-variant]="variant()"
        [animate.leave]="'leaving'"
      >
        @if (pwa.showSkeleton()) {
          <span class="ui-visually-hidden" i18n="@@pwa.updating">Atualizando…</span>
        } @else {
          <span class="ui-visually-hidden" i18n="@@pwa.loading">Carregando…</span>
        }
        @if (pageTimedOut()) {
          <div class="bs-timeout ui-notice warn" role="alert">
            <p i18n="@@pwa.loading-timeout">A tela ainda está carregando.</p>
            <button type="button" class="secondary ui-btn" (click)="reload()" i18n="@@pwa.loading-retry">Tentar de Novo</button>
          </div>
        }
        @switch (drawing()) {
          @case ('home') {
            <div class="bs-variant bs-page bs-home bs-draw" aria-hidden="true">
              <span class="bone ui-skeleton bs-brand"></span>
              <div class="bs-home-hero">
                <span class="bs-hero-actions">
                  <span class="bone ui-skeleton bs-gear"></span>
                  <span class="bone ui-skeleton bs-dot"></span>
                </span>
                <span class="bs-home-hero-text">
                  <span class="bone ui-skeleton bs-line bs-w40"></span>
                  <span class="bone ui-skeleton bs-line bs-big bs-w80"></span>
                </span>
                <span class="bone ui-skeleton bs-time"></span>
              </div>
              <div class="bs-section-head">
                <span class="bone ui-skeleton bs-line bs-big bs-w30"></span>
                <span class="bone ui-skeleton bs-line bs-w20"></span>
              </div>
              <div class="bs-modules">
                @for (module of modules; track module) {
                  <div class="bs-module">
                    <span class="bone ui-skeleton bs-app"></span>
                    <span class="bone ui-skeleton bs-line bs-w60"></span>
                  </div>
                }
              </div>
            </div>
          }
          @case ('tv') {
            <div class="bs-variant bs-tv bs-draw" aria-hidden="true">
              <div class="bs-tv-col">
                <div class="bs-tv-head">
                  <span class="bs-tv-lead">
                    <span class="bone ui-skeleton bs-circle"></span>
                    <span class="bone ui-skeleton bs-circle"></span>
                  </span>
                  <span class="bone ui-skeleton bs-tv-title"></span>
                  <span class="bs-tv-actions">
                    <span class="bs-tv-state"
                      ><span class="bone ui-skeleton bs-state-dot"></span
                    ></span>
                    <span class="bone ui-skeleton bs-circle"></span>
                  </span>
                </div>
                <div class="bs-tv-shortcuts">
                  @for (tile of tiles; track tile) {
                    <span class="bone ui-skeleton bs-tile"></span>
                  }
                </div>
                <div class="bs-tv-stage">
                  <div class="bs-tv-viewport">
                    <span class="bone ui-skeleton bs-ring">
                      <span class="bs-disk">
                        <span class="bone ui-skeleton bs-arrow bs-up"></span>
                        <span class="bone ui-skeleton bs-arrow bs-right"></span>
                        <span class="bone ui-skeleton bs-arrow bs-down"></span>
                        <span class="bone ui-skeleton bs-arrow bs-left"></span>
                        <span class="bone ui-skeleton bs-ok"></span>
                      </span>
                    </span>
                  </div>
                  <div class="bs-tv-dots">
                    @for (pip of pips; track pip) {
                      <span class="bs-pip-cell"><span class="bone ui-skeleton bs-pip"></span></span>
                    }
                  </div>
                </div>
                <div class="bs-tv-bottom">
                  <span class="bs-vpill">
                    <span class="bone ui-skeleton bs-mark"></span>
                    <span class="bone ui-skeleton bs-level"></span>
                    <span class="bone ui-skeleton bs-mark"></span>
                  </span>
                  <div class="bs-rounds">
                    @for (key of keys; track key) {
                      <span class="bone ui-skeleton bs-round-key"></span>
                    }
                  </div>
                  <span class="bs-vpill">
                    <span class="bone ui-skeleton bs-mark"></span>
                    <span class="bone ui-skeleton bs-level"></span>
                    <span class="bone ui-skeleton bs-mark"></span>
                  </span>
                </div>
              </div>
            </div>
          }
          @case ('training') {
            <div class="bs-variant bs-training bs-draw" aria-hidden="true">
              <div class="bs-topbar">
                <span class="bone ui-skeleton bs-back"></span>
                <span class="bone ui-skeleton bs-title"></span>
                <span class="bs-end"></span>
              </div>
              <div class="bs-body bs-training-today-content">
                <div class="bs-hero">
                  <span class="bone ui-skeleton bs-line bs-w40"></span>
                  <span class="bone ui-skeleton bs-line bs-big bs-w80"></span>
                  <span class="bone ui-skeleton bs-cta"></span>
                </div>
                <div class="bs-card">
                  <div class="bs-week-head">
                    <span class="bone ui-skeleton bs-line bs-big"></span>
                    <span class="bone ui-skeleton bs-line bs-w20"></span>
                  </div>
                  <div class="bs-days">
                    @for (day of days; track day) {
                      <span class="bone ui-skeleton bs-day"></span>
                    }
                  </div>
                  <div class="bs-stats">
                    @for (stat of stats; track stat) {
                      <span class="bs-stat">
                        <span class="bone ui-skeleton bs-line bs-big bs-w60"></span>
                        <span class="bone ui-skeleton bs-line bs-w40"></span>
                      </span>
                    }
                  </div>
                </div>
              </div>
              <div class="bs-body bs-training-list-content">
                <div class="bs-list">
                  @for (row of rows; track row) {
                    <div class="bs-row"><span class="bone ui-skeleton bs-icon"></span><span class="bs-lines"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></span><span class="bone ui-skeleton bs-chevron"></span></div>
                  }
                </div>
              </div>
              <div class="bs-body bs-training-progress-content">
                <div class="bs-segments">
                  @for (segment of twoTabs; track segment) { <span class="bone ui-skeleton bs-segment"></span> }
                </div>
                <div class="bs-card bs-chart"><span class="bone ui-skeleton bs-line bs-w40"></span><span class="bone ui-skeleton bs-chart-line"></span></div>
                <div class="bs-stats">@for (stat of stats; track stat) { <span class="bs-stat"><span class="bone ui-skeleton bs-line bs-big bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></span> }</div>
              </div>
              <div class="bs-body bs-training-body-content">
                <div class="bs-segments">
                  @for (segment of twoTabs; track segment) { <span class="bone ui-skeleton bs-segment"></span> }
                </div>
                <div class="bs-card bs-body-map"><span class="bone ui-skeleton bs-figure"></span><span class="bone ui-skeleton bs-line bs-big bs-w40"></span></div>
                <div class="bs-list">@for (row of rows; track row) { <div class="bs-row"><span class="bone ui-skeleton bs-icon bs-round"></span><span class="bs-lines"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w30"></span></span></div> }</div>
              </div>
              <div class="bs-tabs">
                @for (tab of threeTabs; track tab) {
                  <span class="bone ui-skeleton bs-tab"></span>
                }
              </div>
            </div>
          }
          @case ('settings') {
            <div class="bs-variant bs-settings bs-draw" aria-hidden="true">
              <div class="bs-topbar bs-shell">
                <span class="bone ui-skeleton bs-back"></span>
                <span class="bone ui-skeleton bs-title"></span>
                <span class="bs-end"></span>
              </div>
              <div class="bs-body">
                <div class="bs-segments">
                  @for (segment of threeTabs; track segment) {
                    <span class="bone ui-skeleton bs-segment"></span>
                  }
                </div>
                @for (group of groups; track group) {
                  <span class="bone ui-skeleton bs-section-label"></span>
                  <div class="bs-group">
                    @for (setting of settingRows; track setting) {
                      <div class="bs-setting">
                        <span class="bone ui-skeleton bs-icon"></span>
                        <span class="bone ui-skeleton bs-line"></span>
                        <span class="bone ui-skeleton bs-chevron"></span>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          }
          @case ('detail') {
            <div class="bs-variant bs-detail bs-draw" aria-hidden="true">
              <div class="bs-topbar bs-shell">
                <span class="bone ui-skeleton bs-back"></span>
                <span class="bone ui-skeleton bs-title"></span>
                <span class="bs-end"></span>
              </div>
              <div class="bs-body">
                <div class="bs-detail-cards">
                @for (card of cards; track card) {
                  <div class="bs-card">
                    <span class="bone ui-skeleton bs-line bs-w40"></span>
                    <span class="bone ui-skeleton bs-line bs-w80"></span>
                    <span class="bone ui-skeleton bs-line bs-w60"></span>
                  </div>
                }
                </div>
                <div class="bs-settings-data-content bs-list">
                  @for (row of rows; track row) { <div class="bs-row"><span class="bone ui-skeleton bs-icon"></span><span class="bs-lines"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></span><span class="bone ui-skeleton bs-chip"></span></div> }
                </div>
                <div class="bs-settings-profile-content bs-form"><div class="bs-identity"><span class="bone ui-skeleton bs-avatar"></span><span class="bs-lines"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></span></div><span class="bone ui-skeleton bs-line bs-w30"></span><span class="bone ui-skeleton bs-input"></span><span class="bone ui-skeleton bs-cta"></span><div class="bs-card"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></div><div class="bs-card"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-cta"></span></div></div>
                <div class="bs-settings-appearance-content bs-form"><span class="bone ui-skeleton bs-line bs-w30"></span><div class="bs-theme-choices"><span class="bone ui-skeleton bs-theme-choice"></span><span class="bone ui-skeleton bs-theme-choice"></span><span class="bone ui-skeleton bs-theme-choice"></span></div><div class="bs-row"><span class="bone ui-skeleton bs-icon"></span><span class="bs-lines"><span class="bone ui-skeleton bs-line bs-w60"></span><span class="bone ui-skeleton bs-line bs-w40"></span></span></div></div>
              </div>
            </div>
          }
          @case ('plain') {
            <div class="bs-variant bs-plain bs-draw" aria-hidden="true">
              <div class="bs-card">
                <span class="bone ui-skeleton bs-line bs-big bs-w60"></span>
                <span class="bone ui-skeleton bs-line bs-w80"></span>
                <span class="bone ui-skeleton bs-cta"></span>
              </div>
            </div>
          }
          @default {
            <div class="bs-variant bs-generic bs-draw" aria-hidden="true">
              <div class="bs-page">
                <div class="bs-flat-top">
                  <span class="bone ui-skeleton bs-flat-back"></span>
                  <span class="bone ui-skeleton bs-flat-title"></span>
                  <span class="bone ui-skeleton bs-avatar"></span>
                </div>
                <div class="bs-hero">
                  <span class="bone ui-skeleton bs-line bs-w40"></span>
                  <span class="bone ui-skeleton bs-line bs-big bs-w80"></span>
                  <span class="bone ui-skeleton bs-line bs-w60"></span>
                  <span class="bone ui-skeleton bs-pill"></span>
                </div>
                <div class="bs-grid">
                  @for (card of cards; track card) {
                    <div class="bs-card">
                      <span class="bone ui-skeleton bs-icon"></span>
                      <span class="bone ui-skeleton bs-line bs-w70"></span>
                      <span class="bone ui-skeleton bs-line bs-w40"></span>
                    </div>
                  }
                </div>
                <div class="bs-list">
                  @for (row of rows; track row) {
                    <div class="bs-row">
                      <span class="bone ui-skeleton bs-icon bs-round"></span>
                      <span class="bs-lines">
                        <span class="bone ui-skeleton bs-line bs-w60"></span>
                        <span class="bone ui-skeleton bs-line bs-w30"></span>
                      </span>
                      <span class="bone ui-skeleton bs-chip"></span>
                    </div>
                  }
                </div>
              </div>
              <div class="bs-tabs">
                @for (tab of tabs; track tab) {
                  <span class="bone ui-skeleton bs-tab"></span>
                }
              </div>
            </div>
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class UpdateSkeleton {
  protected readonly pwa = inject(PwaUpdateService);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;
  /** A primeira navegação do app passou de `SLOW_BOOT_MS` sem terminar: a abertura está lenta. */
  private readonly slowBoot = signal(false);
  /** Uma navegação já dentro do app passou de `ROUTE_WAIT_MS`: o endereço de destino diz que desenho mostrar. */
  private readonly routeWait = signal<string | null>(null);
  /** A primeira navegação terminou (ou falhou): um temporizador atrasado não pode ligar o esqueleto depois disso. */
  private bootDone = false;
  private routeTimer: number | undefined;
  private pageReadyTimer: number | undefined;
  private readonly waitingForPage = signal(false);
  protected readonly pageTimedOut = signal(false);
  private readyObserver: MutationObserver | undefined;
  protected readonly visible = computed(
    () =>
      this.pwa.showSkeleton() ||
      this.slowBoot() ||
      this.routeWait() !== null ||
      this.waitingForPage() ||
      this.pageTimedOut(),
  );

  /**
   * O desenho que cobre a tela: o da rota de destino quando é uma navegação dentro do app, e o do endereço do navegador
   * na abertura ou na atualização. Lê o endereço do navegador, e não o do roteador: o roteador ainda diz "/" antes de a
   * primeira navegação terminar, e quem recarrega em "/tv" não pode ver a Início por baixo do esqueleto.
   */
  protected readonly variant = computed<BootVariant>(() => {
    // Relê o endereço só quando o esqueleto aparece: um redirecionamento no meio da espera não troca o desenho.
    this.visible();
    const target = this.routeWait();
    return bootVariantFor(target ?? this.win?.location.pathname ?? '/');
  });
  /** Variações da mesma casca usam o desenho de base correspondente; o atributo conserva a rota exata para CSS e testes. */
  protected readonly drawing = computed(() => {
    const variant = this.variant();
    if (variant.startsWith('training-')) return 'training';
    if (variant.startsWith('settings-')) return variant === 'settings' ? 'settings' : 'detail';
    return variant;
  });
  protected readonly modules = [1, 2, 3, 4, 5, 6, 7, 8];
  protected readonly cards = [1, 2, 3, 4];
  protected readonly rows = [1, 2, 3, 4];
  protected readonly tabs = [1, 2, 3, 4];
  protected readonly threeTabs = [1, 2, 3];
  protected readonly twoTabs = [1, 2];
  protected readonly tiles = [1, 2, 3];
  protected readonly pips = [1, 2, 3];
  protected readonly keys = [1, 2, 3, 4, 5, 6, 7, 8];
  protected readonly days = [1, 2, 3, 4, 5, 6, 7];
  protected readonly stats = [1, 2, 3];
  protected readonly groups = [1, 2];
  protected readonly settingRows = [1, 2, 3];

  constructor() {
    const router = inject(Router);
    // A rota que terminou (ou falhou) é o primeiro conteúdo; se a primeira navegação já acabou antes de o esqueleto
    // nascer, vale o estado do roteador.
    if (router.navigated) {
      this.bootDone = true;
      this.waitForPageReady();
    } else this.watchSlowBoot();
    router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) {
        if (this.bootDone && this.changesTopModule(event.url)) this.armRouteWait(event.url);
        return;
      }
      // Um guarda que redireciona (sessão vencida, boas-vindas) cancela esta navegação e começa outra: ainda não há conteúdo,
      // o esqueleto segue até a navegação seguinte terminar.
      const handedOver =
        event instanceof NavigationCancel &&
        (event.code === NavigationCancellationCode.Redirect ||
          event.code === NavigationCancellationCode.SupersededByNewNavigation);
      if (
        !handedOver &&
        (event instanceof NavigationEnd ||
          event instanceof NavigationCancel ||
          event instanceof NavigationError)
      ) {
        this.bootDone = true;
        this.slowBoot.set(false);
        this.clearRouteWait();
        this.waitForPageReady();
      }
    });
    this.doc.addEventListener('uniover:page-ready', this.contentReady);
    inject(DestroyRef).onDestroy(() => {
      this.win?.clearTimeout(this.routeTimer);
      this.win?.clearTimeout(this.pageReadyTimer);
      this.readyObserver?.disconnect();
      this.doc.removeEventListener('uniover:page-ready', this.contentReady);
      this.doc.documentElement.classList.remove('has-boot-skeleton');
    });
    // Com o desenho do Angular por cima, o estático (idêntico) fica oculto por baixo: duas camadas de brilho custam pintura
    // em dobro, e num celular lento isso derruba a fluidez justo na espera.
    afterRenderEffect(() => {
      const visible = this.visible();
      this.doc.getElementById(BOOT_SKELETON_ID)?.classList.toggle('bs-covered', visible);
      this.doc.documentElement.classList.toggle('has-boot-skeleton', visible);
    });
  }

  /** Na abertura, se a primeira navegação ainda não terminou depois de `SLOW_BOOT_MS`, liga o esqueleto. */
  private watchSlowBoot(): void {
    const win = this.win;
    if (!win) return;
    const timer = win.setTimeout(() => {
      if (!this.bootDone) this.slowBoot.set(true);
    }, SLOW_BOOT_MS);
    inject(DestroyRef).onDestroy(() => win.clearTimeout(timer));
  }

  /** Uma navegação nova dentro do app: se ela demorar, o esqueleto da tela de destino cobre a espera. */
  private armRouteWait(url: string): void {
    const win = this.win;
    if (!win) return;
    win.clearTimeout(this.routeTimer);
    this.routeTimer = win.setTimeout(() => this.routeWait.set(url), ROUTE_WAIT_MS);
  }

  /** Só uma troca entre módulos troca a casca inteira; abas, telas filhas e consulta preservam o cabeçalho visível. */
  private changesTopModule(target: string): boolean {
    const moduleOf = (url: string): string => {
      const path = url.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
      if (path === '/') return '/';
      const [segment] = path.slice(1).split('/');
      return `/${segment}`;
    };
    return moduleOf(target) !== moduleOf(this.win?.location.pathname ?? '/');
  }

  private clearRouteWait(): void {
    this.win?.clearTimeout(this.routeTimer);
    this.routeTimer = undefined;
    this.routeWait.set(null);
  }

  /** O LoadingFrame anuncia a primeira forma; os marcadores da rota cobrem conteúdo síncrono e esqueletos locais. */
  private readonly contentReady = (): void => {
    if (this.waitingForPage() && this.hasScreenMarker()) this.finishPageReady();
  };

  private waitForPageReady(): void {
    if (this.waitingForPage()) return;
    this.pageTimedOut.set(false);
    this.doc.documentElement.removeAttribute('data-screen-timeout');
    this.waitingForPage.set(true);
    this.watchScreenMarker();
    if (this.hasScreenMarker()) {
      this.finishPageReady();
      return;
    }
    const win = this.win;
    if (win) {
      this.pageReadyTimer = win.setTimeout(() => this.keepOwnSkeletonOnTimeout(), PAGE_READY_TIMEOUT_MS);
    }
  }

  private finishPageReady(): void {
    if (!this.waitingForPage()) return;
    this.waitingForPage.set(false);
    this.win?.clearTimeout(this.pageReadyTimer);
    this.pageReadyTimer = undefined;
    this.readyObserver?.disconnect();
    this.readyObserver = undefined;
    this.pwa.markContentReady();
    this.dismissBootSkeleton();
  }

  /** A rota não deixou conteúdo nem forma local no prazo: preserva o desenho dela e registra a causa. */
  private keepOwnSkeletonOnTimeout(): void {
    if (!this.waitingForPage()) return;
    this.waitingForPage.set(false);
    this.pageTimedOut.set(true);
    this.readyObserver?.disconnect();
    this.readyObserver = undefined;
    this.doc.documentElement.setAttribute('data-screen-timeout', this.variant());
    this.win?.sessionStorage.setItem(
      'uniover.screen-timeout',
      JSON.stringify({ variant: this.variant(), reason: 'missing-screen-marker' }),
    );
    this.doc.dispatchEvent(
      new CustomEvent('uniover:screen-timeout', {
        detail: { variant: this.variant(), reason: 'missing-screen-marker' },
      }),
    );
  }

  private watchScreenMarker(): void {
    this.readyObserver?.disconnect();
    this.readyObserver = new MutationObserver(() => {
      if (this.waitingForPage() && this.hasScreenMarker()) this.finishPageReady();
    });
    this.readyObserver.observe(this.doc.body, { attributes: true, childList: true, subtree: true });
  }

  private hasScreenMarker(): boolean {
    const marker = this.screenMarker();
    return !!this.doc.querySelector(`[data-screen-ready="${marker}"], [data-screen-skeleton="${marker}"]`);
  }

  /**
   * O marcador esperado vem do endereço de agora, e não do desenho que cobre a tela: um guarda que redireciona (de /tv
   * para /entrar) muda a tela que vai aparecer sem trocar o desenho no meio da espera.
   */
  private screenMarker(): string {
    const variant = bootVariantFor(this.win?.location.pathname ?? '/');
    if (variant.startsWith('training-')) return 'training';
    if (
      variant === 'settings-system' ||
      variant === 'settings-people' ||
      variant === 'settings-audit' ||
      variant === 'settings-devices'
    )
      return 'settings-data';
    return variant;
  }

  protected reload(): void {
    this.doc.location.reload();
  }

  /**
   * Retira o esqueleto estático do `index.html`: a primeira tela está pronta. Sai com a mesma animação de saída do
   * esqueleto do Angular (a classe `leaving`) e só depois é tirado do documento. Sem o elemento (já retirado, ou um teste),
   * não faz nada.
   */
  private dismissBootSkeleton(): void {
    const element = this.doc.getElementById(BOOT_SKELETON_ID);
    if (!element) return;
    element.classList.add('leaving');
    const win = this.win;
    if (win) win.setTimeout(() => element.remove(), BOOT_LEAVE_MS);
    else element.remove();
  }
}
