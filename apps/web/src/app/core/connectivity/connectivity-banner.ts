import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService, type ServerState } from './connectivity.service';

/**
 * Quanto o estado "iniciando" precisa durar para a faixa aparecer. Ao abrir o app, dois pedidos que caem juntos já o
 * acendem e a resposta seguinte o apaga: a faixa piscava no topo. Uma falha de verdade dura mais que isto e aparece.
 */
export const WAKING_NOTICE_DELAY_MS = 2_000;

/**
 * Mostra o estado da conexão. A faixa de "iniciando" só entra se o estado durar `WAKING_NOTICE_DELAY_MS` (sem piscar);
 * a de sem conexão entra na hora. O contador fica fora da leitura de tela para não anunciar a cada segundo. A faixa
 * abre e fecha empurrando a tela (ver `ui-collapse` em styles.css), sem salto.
 */
@Component({
  selector: 'app-connectivity-banner',
  template: `
    <div class="slot" role="status">
      @switch (shown()) {
        @case ('waking') {
          <div class="ui-collapse" [animate.leave]="'leaving'">
            <div class="ui-collapse-inner">
              <p class="banner waking">
                <span i18n="@@connectivity.waking">O UniOver está iniciando…</span>
                <span aria-hidden="true" i18n="@@connectivity.waiting"
                  >aguardando há {{ connectivity.waitedSeconds() }} s</span
                >
              </p>
            </div>
          </div>
        }
        @case ('offline') {
          <div class="ui-collapse" [animate.leave]="'leaving'">
            <div class="ui-collapse-inner">
              <p class="banner offline">
                @if (connectivity.windowExpired()) {
                  <span i18n="@@connectivity.no-answer"
                    >O UniOver não respondeu. O que já está neste aparelho continua
                    funcionando.</span
                  >
                } @else {
                  <span i18n="@@connectivity.offline"
                    >Sem conexão. O que já está neste aparelho continua funcionando.</span
                  >
                }
              </p>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: `
    .banner {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      margin: 0;
      padding: 10px var(--gutter);
      font-size: 0.9rem;
      border-bottom: 1px solid var(--a-line);
      background: var(--a-elev);
      color: var(--a-ink);
    }
    .waking span:first-child {
      font-weight: 600;
    }
    .offline {
      border-left: 4px solid var(--a-warn);
    }
  `,
})
export class ConnectivityBanner {
  protected readonly connectivity = inject(ConnectivityService);
  /** O estado que a faixa mostra: o do serviço, com o "iniciando" segurado até durar o bastante. */
  protected readonly shown = signal<ServerState>('ok');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const state = this.connectivity.serverState();
      clearTimeout(this.timer);
      this.timer = undefined;
      if (state !== 'waking') {
        this.shown.set(state);
        return;
      }
      if (untracked(this.shown) === 'waking') return;
      // Enquanto espera, nada de faixa: o aviso anterior (sem conexão) já não vale.
      this.shown.set('ok');
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.shown.set('waking');
      }, WAKING_NOTICE_DELAY_MS);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }
}
