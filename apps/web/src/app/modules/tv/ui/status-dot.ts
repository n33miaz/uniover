import { Component, input } from '@angular/core';
import { TvPhase } from '../data/tv-status';
import { PcOffIcon } from './pc-off-icon';

/**
 * Ponto de estado do controle. Cada fase tem cor **e** forma próprias, para a cor não ser a única pista:
 * conectada (cheio, verde), dormindo (anel, azul-acinzentado), conectando (alvo que pulsa, VERDE: ainda sem certeza não
 * é falha), sem resposta (cheio com exclamação, âmbar), agente desligado (círculo com traço, cinza), PC desligado (monitor
 * dormindo, cinza), sem rede (círculo cortado, vermelho) e atenção (ponto de exclamação, vermelho). É decorativo: o nome
 * do estado vem do botão ou do painel que o usa.
 */
@Component({
  selector: 'app-status-dot',
  imports: [PcOffIcon],
  template: `
    @if (phase() === 'pc-off') {
      <app-pc-off-icon class="dot monitor" [attr.data-phase]="phase()" />
    } @else {
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        class="dot"
        [attr.data-phase]="phase()"
      >
        @switch (phase()) {
          @case ('connected') {
            <circle cx="12" cy="12" r="8" class="fill" />
          }
          @case ('sleeping') {
            <circle cx="12" cy="12" r="7" class="ring" />
          }
          @case ('connecting') {
            <circle cx="12" cy="12" r="9" class="ring pulse" />
            <circle cx="12" cy="12" r="4.5" class="fill" />
          }
          @case ('no-reply') {
            <circle cx="12" cy="12" r="8.5" class="fill" />
            <path [attr.d]="'M12 7v6'" class="glyph" />
            <path [attr.d]="'M12 16.5h.01'" class="glyph" />
          }
          @case ('agent-off') {
            <circle cx="12" cy="12" r="8" class="ring" />
            <path [attr.d]="'M8 12h8'" class="glyph-own" />
          }
          @case ('offline') {
            <circle cx="12" cy="12" r="8.5" class="fill" />
            <path [attr.d]="'M7.5 7.5l9 9'" class="glyph" />
          }
          @default {
            <circle cx="12" cy="12" r="8.5" class="fill" />
            <path [attr.d]="'M12 7v6'" class="glyph" />
            <path [attr.d]="'M12 16.5h.01'" class="glyph" />
          }
        }
      </svg>
    }
  `,
  styleUrl: './status-dot.css',
})
export class StatusDot {
  readonly phase = input.required<TvPhase>();
}
