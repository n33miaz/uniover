import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  Router,
} from '@angular/router';
import { PwaUpdateService } from './pwa-update.service';

/** Quanto a primeira tela pode demorar na abertura antes de o esqueleto cobri-la (abaixo disso, a troca é imperceptível). */
export const SLOW_BOOT_MS = 300;

/**
 * Cobre a tela inteira com um esqueleto que brilha em dois momentos em que, sem ele, só haveria o fundo vazio: do toque em
 * "Atualizar" até o primeiro conteúdo da página nova (a casca nova sobe) e na abertura do app quando a primeira tela demora
 * (conexão lenta, servidor acordando: o guarda de entrada espera a sessão antes de mostrar qualquer coisa). Nessa abertura
 * o esqueleto só aparece se a espera passar de `SLOW_BOOT_MS`, para uma abertura rápida não piscar.
 * Autocontido: só usa os tokens de cor (`--a-*`) e o brilho único do app (ui-skeleton, em styles.css), que segue os dois
 * temas e, com `prefers-reduced-motion`, vira uma pulsação sem deslocamento (parado, ele pareceria travado). A rota que
 * termina de ativar (ou falha) entrega o primeiro conteúdo; o esqueleto sai pela mesma animação de saída dos avisos.
 */
@Component({
  selector: 'app-update-skeleton',
  template: `
    @if (visible()) {
      <div class="overlay" role="status" [animate.leave]="'leaving'">
        @if (pwa.showSkeleton()) {
          <span class="ui-visually-hidden" i18n="@@pwa.updating">Atualizando…</span>
        } @else {
          <span class="ui-visually-hidden" i18n="@@pwa.loading">Carregando…</span>
        }
        @if (home()) {
          <div class="page home" aria-hidden="true">
            <span class="bone ui-skeleton brand"></span>
            <div class="home-hero">
              <span class="hero-actions">
                <span class="bone ui-skeleton gear"></span>
                <span class="bone ui-skeleton dot"></span>
              </span>
              <span class="home-hero-text">
                <span class="bone ui-skeleton line w40"></span>
                <span class="bone ui-skeleton line big w80"></span>
              </span>
              <span class="bone ui-skeleton time"></span>
            </div>
            <div class="section-head">
              <span class="bone ui-skeleton line big w30"></span>
              <span class="bone ui-skeleton line w20"></span>
            </div>
            <div class="modules">
              @for (module of modules; track module) {
                <div class="module">
                  <span class="bone ui-skeleton app"></span>
                  <span class="bone ui-skeleton line w60"></span>
                </div>
              }
            </div>
          </div>
        } @else {
          <div class="page" aria-hidden="true">
            <div class="top">
              <span class="bone ui-skeleton back"></span>
              <span class="bone ui-skeleton title"></span>
              <span class="bone ui-skeleton avatar"></span>
            </div>
            <div class="hero">
              <span class="bone ui-skeleton line w40"></span>
              <span class="bone ui-skeleton line big w80"></span>
              <span class="bone ui-skeleton line w60"></span>
              <span class="bone ui-skeleton pill"></span>
            </div>
            <div class="grid">
              @for (card of cards; track card) {
                <div class="card">
                  <span class="bone ui-skeleton icon"></span>
                  <span class="bone ui-skeleton line w70"></span>
                  <span class="bone ui-skeleton line w40"></span>
                </div>
              }
            </div>
            <div class="list">
              @for (row of rows; track row) {
                <div class="row">
                  <span class="bone ui-skeleton icon round"></span>
                  <span class="lines">
                    <span class="bone ui-skeleton line w60"></span>
                    <span class="bone ui-skeleton line w30"></span>
                  </span>
                  <span class="bone ui-skeleton chip"></span>
                </div>
              }
            </div>
          </div>
          <div class="tabs" aria-hidden="true">
            @for (tab of tabs; track tab) {
              <span class="bone ui-skeleton tab"></span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--a-bg);
      color: var(--a-ink);
      /* Entra cobrindo tudo no mesmo quadro do toque: sem fade de entrada, só a saída é suave. */
    }
    .overlay.leaving {
      animation: fade-out var(--dur-exit) var(--ease-out) forwards;
      pointer-events: none;
    }
    .page {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      width: 100%;
      max-width: 760px;
      margin: 0 auto;
      padding: calc(var(--space-4) + env(safe-area-inset-top, 0px)) var(--gutter) var(--space-4);
      box-sizing: border-box;
    }
    .top {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--tap);
    }
    .top .title {
      flex: 1;
      max-width: 180px;
      height: 24px;
    }
    .top .back {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-pill);
    }
    .top .avatar {
      width: 36px;
      height: 36px;
      margin-inline-start: auto;
      border-radius: var(--radius-pill);
    }
    .hero,
    .card,
    .row {
      border: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .hero {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-5);
      border-radius: var(--radius-lg);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-4);
      border-radius: var(--radius-sm);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-sm);
    }
    .lines {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .tabs {
      display: flex;
      justify-content: space-around;
      align-items: center;
      padding: var(--space-3) var(--gutter) calc(var(--space-3) + var(--safe-bottom));
      border-top: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .tab {
      width: 40px;
      height: 28px;
      border-radius: var(--radius-pill);
    }
    /* Variante da Início: mesma coluna, mesmas medidas e mesmos raios da tela real, para a troca não dar salto. */
    .page.home {
      max-width: calc(46rem + 2 * var(--gutter));
      padding-top: calc(var(--gutter) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(var(--gutter) + var(--safe-bottom));
      gap: var(--space-4);
    }
    .home-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: var(--space-3);
      min-height: clamp(136px, 21vw, 172px);
      padding: clamp(var(--space-5), 3vw, var(--space-6));
      border: 1px solid color-mix(in srgb, var(--a-accent) 22%, var(--a-line));
      border-radius: var(--radius-xl);
      background: var(--a-hero);
      box-shadow: var(--shadow-2);
    }
    .home-hero-text {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .time {
      width: clamp(76px, 18vw, 104px);
      height: clamp(28px, 7vw, 36px);
      border-radius: var(--radius-sm);
    }
    .modules {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .module {
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      box-shadow: var(--shadow-1);
    }
    /* A marca "UniOver" e as ações do cartão (engrenagem e ponto de estado) ficam onde estão na tela real. */
    .brand {
      width: 4.75rem;
      height: 17px;
      margin-inline: var(--space-1);
    }
    .home-hero {
      position: relative;
    }
    .hero-actions {
      position: absolute;
      top: var(--space-3);
      left: var(--space-3);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .gear {
      width: 22px;
      height: 22px;
      border-radius: var(--radius-pill);
    }
    .dot {
      width: 16px;
      height: 16px;
      border-radius: var(--radius-pill);
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-height: var(--tap);
      margin-top: var(--space-1);
      padding-inline: var(--space-1);
    }
    .section-head .big {
      width: 7rem;
      height: 22px;
    }
    .section-head .w20 {
      width: 3.5rem;
    }
    .module {
      flex-direction: column;
      gap: var(--space-3);
      min-height: clamp(160px, 42vw, 176px);
      padding: var(--space-4) var(--space-3);
    }
    .module .line {
      width: 60%;
    }
    .app {
      width: clamp(72px, 19vw, 80px);
      height: clamp(72px, 19vw, 80px);
      border-radius: var(--radius-sm);
    }
    .w20 {
      width: 20%;
    }
    @media (min-width: 600px) {
      .modules {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    /* O brilho vem da classe única de espera (ui-skeleton, em styles.css): aqui só a forma de cada osso. O mínimo
       dela não vale: cada osso tem a medida do que ele substitui. */
    .bone {
      display: block;
      min-height: 0;
    }
    .line {
      height: 14px;
    }
    .line.big {
      height: 28px;
    }
    .w30 {
      width: 30%;
    }
    .w40 {
      width: 40%;
    }
    .w60 {
      width: 60%;
    }
    .w70 {
      width: 70%;
    }
    .w80 {
      width: 80%;
    }
    .pill {
      width: 120px;
      height: var(--tap);
      border-radius: var(--radius);
      margin-top: var(--space-2);
    }
    .icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-xs);
    }
    .icon.round {
      border-radius: var(--radius-pill);
    }
    .chip {
      width: 44px;
      height: 22px;
      border-radius: var(--radius-pill);
    }
    @media (min-width: 640px) {
      .grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .tabs {
        display: none;
      }
    }
    @keyframes fade-out {
      to {
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .overlay,
      .overlay.leaving {
        animation: none;
      }
    }
  `,
})
export class UpdateSkeleton {
  protected readonly pwa = inject(PwaUpdateService);
  private readonly win = inject(DOCUMENT).defaultView;
  /** A primeira navegação do app passou de `SLOW_BOOT_MS` sem terminar: a abertura está lenta. */
  private readonly slowBoot = signal(false);
  /** A primeira navegação terminou (ou falhou): um temporizador atrasado não pode ligar o esqueleto depois disso. */
  private bootDone = false;
  protected readonly visible = computed(() => this.pwa.showSkeleton() || this.slowBoot());

  /**
   * Na Início (a raiz) o esqueleto reproduz a tela; nas demais rotas, um desenho genérico de página. Lê o endereço do
   * navegador, e não o do roteador: o roteador ainda diz "/" antes de a primeira navegação terminar, e
   * quem recarrega em "/tv" não pode ver a Início por baixo do esqueleto.
   */
  protected readonly home = computed(() => {
    // Relê o endereço só quando o esqueleto aparece: um redirecionamento no meio da espera não troca o desenho.
    this.visible();
    return this.win?.location.pathname === '/';
  });
  protected readonly modules = [1, 2, 3, 4, 5, 6, 7, 8];
  protected readonly cards = [1, 2, 3, 4];
  protected readonly rows = [1, 2, 3, 4];
  protected readonly tabs = [1, 2, 3, 4];

  constructor() {
    const router = inject(Router);
    // A rota que terminou (ou falhou) é o primeiro conteúdo; se a primeira navegação já acabou antes de o esqueleto
    // nascer, vale o estado do roteador.
    if (router.navigated) {
      this.bootDone = true;
      this.pwa.markContentReady();
    } else this.watchSlowBoot();
    router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
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
        this.pwa.markContentReady();
        this.bootDone = true;
        this.slowBoot.set(false);
      }
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
}
