import { Component } from '@angular/core';

/**
 * "Monitor Dormindo": um monitor com dois "z" na tela. É o ícone do estado "PC Desligado", no ponto do cabeçalho e no
 * selo sobre os controles esmaecidos. Só traço (usa `currentColor`), decorativo: o nome do estado vem de quem o usa. Os
 * "z" são desenhados como traços, e não como texto, para não dependerem da fonte do aparelho.
 */
@Component({
  selector: 'app-pc-off-icon',
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path [attr.d]="'M9 20h6M12 16v4'" />
      <path class="z" [attr.d]="'M9.2 9.4h2.6l-2.6 3.4h2.6'" />
      <path class="z" [attr.d]="'M13.4 6.2h3.8l-3.8 4.6h3.8'" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 1.5rem;
      height: 1.5rem;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .z {
      stroke-width: 1.5;
    }
  `,
})
export class PcOffIcon {}
