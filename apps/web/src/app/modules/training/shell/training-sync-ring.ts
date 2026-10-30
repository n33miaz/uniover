import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TrainingSyncIndicator } from './training-sync-indicator';

/**
 * O anel de progresso do topo do Treino, colado à esquerda dos três pontos dentro da mesma pílula. Em dia: anel fechado
 * verde. Sincronizando: arco que gira (com movimento reduzido vira tracejado parado). Pendente: tracejado com o número.
 * Sem rede: anel cinza vazado. Erro: vermelho com "!". Tocar abre a folha com o estado; nunca dispara a sincronização.
 */
@Component({
  selector: 'app-training-sync-ring',
  template: `
    <button
      type="button"
      class="ring"
      [attr.data-state]="state()"
      [attr.aria-haspopup]="'dialog'"
      [attr.aria-label]="label()"
      (click)="indicator.sheetOpen.set(true)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle class="track" [attr.cx]="12" [attr.cy]="12" [attr.r]="9" />
        <circle class="arc" [attr.cx]="12" [attr.cy]="12" [attr.r]="9" />
        @if (state() === 'pending') {
          <text [attr.x]="12" [attr.y]="12.2" class="mark">{{ countText() }}</text>
        } @else if (state() === 'failed') {
          <text [attr.x]="12" [attr.y]="12.2" class="mark">!</text>
        }
      </svg>
    </button>
  `,
  styles: `
    :host {
      display: contents;
    }
    .ring {
      display: grid;
      place-items: center;
      width: var(--tap);
      height: var(--tap);
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--a-ink2);
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .ring:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: -3px;
    }
    svg {
      width: 26px;
      height: 26px;
      overflow: visible;
    }
    circle {
      fill: none;
      stroke-width: 2.4;
      stroke-linecap: round;
    }
    .track {
      stroke: currentColor;
      opacity: 0.2;
    }
    .arc {
      stroke: currentColor;
      transform-origin: 12px 12px;
    }
    .mark {
      fill: currentColor;
      font: 800 9px/1 sans-serif;
      text-anchor: middle;
      dominant-baseline: central;
    }
    [data-state='ok'] {
      color: var(--a-ok);
    }
    [data-state='ok'] .track {
      opacity: 0;
    }
    [data-state='busy'] {
      color: var(--a-accent-ink);
    }
    [data-state='busy'] .arc {
      stroke-dasharray: 16 41;
      animation: ring-spin 1100ms linear infinite;
    }
    [data-state='pending'] {
      color: var(--a-warn-ink, var(--a-warn));
    }
    [data-state='pending'] .arc {
      stroke-dasharray: 4.5 4.5;
      stroke-linecap: butt;
    }
    [data-state='pending'] .track {
      opacity: 0;
    }
    [data-state='offline'] {
      color: var(--a-ink2);
    }
    [data-state='offline'] .arc {
      opacity: 0.55;
    }
    [data-state='offline'] .track {
      opacity: 0;
    }
    [data-state='failed'] {
      color: var(--a-bad-ink, var(--a-bad));
    }
    @keyframes ring-spin {
      to {
        transform: rotate(360deg);
      }
    }
    /* Sem movimento: o arco para, e o tracejado continua distinguindo "sincronizando" dos outros estados. */
    @media (prefers-reduced-motion: reduce) {
      [data-state='busy'] .arc {
        animation: none;
        stroke-dasharray: 2.5 3.5;
        stroke-linecap: butt;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSyncRing {
  protected readonly indicator = inject(TrainingSyncIndicator);
  protected readonly state = this.indicator.state;

  protected readonly countText = computed(() => {
    const count = this.indicator.count();
    return count > 9 ? '9+' : String(count);
  });

  protected readonly label = computed(() => {
    const count = this.indicator.count();
    switch (this.state()) {
      case 'busy':
        return $localize`:@@training.sync-ring.busy:Sincronizando. Toque para ver o estado.`;
      case 'pending':
        return count === 1
          ? $localize`:@@training.sync-ring.pending-one:1 alteração aguardando envio. Toque para ver o estado.`
          : $localize`:@@training.sync-ring.pending-many:${count}:count: alterações aguardando envio. Toque para ver o estado.`;
      case 'offline':
        return $localize`:@@training.sync-ring.offline:Sem rede. Toque para ver o estado.`;
      case 'failed':
        return $localize`:@@training.sync-ring.failed:Erro ao sincronizar. Toque para ver o estado.`;
      default:
        return $localize`:@@training.sync-ring.ok:Tudo sincronizado. Toque para ver o estado.`;
    }
  });
}
