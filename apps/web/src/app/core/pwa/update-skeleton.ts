import { Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  Router,
} from '@angular/router';
import { PwaUpdateService } from './pwa-update.service';

/**
 * Cobre a tela inteira com um esqueleto que brilha desde o toque em "Atualizar" até o primeiro conteúdo real da
 * página nova: sem ele a pessoa via um "Atualizando…" quase invisível e depois só o fundo, enquanto a casca nova subia.
 * Autocontido: só usa os tokens de cor (`--a-*`), então segue os dois temas, e o brilho para com
 * `prefers-reduced-motion`. A rota que termina de ativar (ou falha) entrega o primeiro conteúdo; o esqueleto sai pela
 * mesma animação de saída dos avisos.
 */
@Component({
  selector: 'app-update-skeleton',
  template: `
    @if (pwa.showSkeleton()) {
      <div class="overlay" role="status" [animate.leave]="'leaving'">
        <span class="ui-visually-hidden" i18n="@@pwa.updating">Atualizando…</span>
        <div class="page" aria-hidden="true">
          <div class="top">
            <span class="bone back"></span>
            <span class="bone title"></span>
            <span class="bone avatar"></span>
          </div>
          <div class="hero">
            <span class="bone line w40"></span>
            <span class="bone line big w80"></span>
            <span class="bone line w60"></span>
            <span class="bone pill"></span>
          </div>
          <div class="grid">
            @for (card of cards; track card) {
              <div class="card">
                <span class="bone icon"></span>
                <span class="bone line w70"></span>
                <span class="bone line w40"></span>
              </div>
            }
          </div>
          <div class="list">
            @for (row of rows; track row) {
              <div class="row">
                <span class="bone icon round"></span>
                <span class="lines">
                  <span class="bone line w60"></span>
                  <span class="bone line w30"></span>
                </span>
                <span class="bone chip"></span>
              </div>
            }
          </div>
        </div>
        <div class="tabs" aria-hidden="true">
          @for (tab of tabs; track tab) {
            <span class="bone tab"></span>
          }
        </div>
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
      padding: var(--space-3) var(--gutter) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .tab {
      width: 40px;
      height: 28px;
      border-radius: var(--radius-pill);
    }
    .bone {
      display: block;
      position: relative;
      overflow: hidden;
      background: var(--a-elev);
      border-radius: var(--radius-xs);
    }
    /* O brilho é uma faixa clara que cruza o osso; só ela se move. */
    .bone::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        100deg,
        transparent 25%,
        var(--a-highlight) 50%,
        var(--a-highlight) 52%,
        transparent 75%
      );
      transform: translateX(-100%);
      animation: sweep 1.5s var(--ease-out) infinite;
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
    @keyframes sweep {
      to {
        transform: translateX(100%);
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
      .bone::after {
        animation: none;
        display: none;
      }
    }
  `,
})
export class UpdateSkeleton {
  protected readonly pwa = inject(PwaUpdateService);
  protected readonly cards = [1, 2, 3, 4];
  protected readonly rows = [1, 2, 3, 4];
  protected readonly tabs = [1, 2, 3, 4];

  constructor() {
    const router = inject(Router);
    // A rota que terminou (ou falhou) é o primeiro conteúdo; se a primeira navegação já acabou antes de o esqueleto
    // nascer, vale o estado do roteador.
    if (router.navigated) this.pwa.markContentReady();
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
      )
        this.pwa.markContentReady();
    });
  }
}
