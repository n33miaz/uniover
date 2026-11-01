import { Component, ElementRef, effect, inject, input, signal, untracked } from '@angular/core';
import { TvPhase } from '../data/tv-status';
import { PcOffIcon } from './pc-off-icon';

/** Duração do pulso do ponto a cada toque no controle. */
export const PULSE_MS = 250;

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
  host: { '[attr.data-pulses]': 'pulses()' },
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
  /**
   * Contador de toques do controle: cada aumento faz o ponto piscar uma vez (~250 ms), sem trocar a cor de estado. Quem
   * não o liga (o ponto dentro do painelzinho) nunca pisca. Com "reduzir movimento" o pulso é só uma variação suave de
   * opacidade, sem crescer.
   */
  readonly pulse = input(0);
  /** Quantos pulsos já foram tocados (também é o gancho dos testes, que não conseguem ver 250 ms de animação). */
  protected readonly pulses = signal(0);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    let previous = untracked(() => this.pulse());
    effect(() => {
      const current = this.pulse();
      if (current === previous) return;
      previous = current;
      untracked(() => this.blink());
    });
  }

  private blink(): void {
    this.pulses.update((count) => count + 1);
    const dot = this.host.nativeElement.querySelector<SVGElement | HTMLElement>('.dot');
    if (!dot || typeof dot.animate !== 'function') return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    dot.animate(
      calm
        ? [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }]
        : [
            { filter: 'brightness(1)', transform: 'scale(1)' },
            {
              filter: 'brightness(1.5) drop-shadow(0 0 3px currentColor)',
              transform: 'scale(1.22)',
            },
            { filter: 'brightness(1)', transform: 'scale(1)' },
          ],
      { duration: PULSE_MS, easing: 'ease-out' },
    );
  }
}
