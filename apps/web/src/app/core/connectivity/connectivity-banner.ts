import { Component, inject } from '@angular/core';
import { ConnectivityService } from './connectivity.service';

/**
 * Mostra o estado da conexão. O contador fica fora da leitura de tela para não anunciar a cada segundo. A faixa
 * abre e fecha empurrando a tela (ver `ui-collapse` em styles.css), sem salto.
 */
@Component({
  selector: 'app-connectivity-banner',
  template: `
    <div class="slot" role="status">
      @switch (connectivity.serverState()) {
        @case ('waking') {
          <div class="ui-collapse" [animate.leave]="'leaving'">
            <div class="ui-collapse-inner">
              <p class="banner waking">
                <span i18n="@@connectivity.waking">Acordando o servidor…</span>
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
                    >O servidor não respondeu. A casca continua disponível.</span
                  >
                } @else {
                  <span i18n="@@connectivity.offline"
                    >Sem conexão. A casca continua disponível.</span
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
}
