import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { PcStore } from '../data/pc-store';

/** O desenho dos botões de cima e de baixo: faixa (anterior e próxima) ou salto de 10 segundos (voltar e avançar). */
export type TransportKind = 'track' | 'seek';

/**
 * Os três botões grandes de reprodução (voltar, tocar e pausar, avançar), os mesmos na Música (faixa) e no Vídeo (10 s).
 * Quem usa decide o que cada toque manda; aqui só estão o desenho, os nomes de quem lê a tela e o estado desligado.
 */
@Component({
  selector: 'app-pc-transport',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="round"
      [attr.data-action]="'previous'"
      [attr.aria-label]="previousLabel()"
      [disabled]="!store.canSend()"
      (click)="previous.emit()"
    >
      @if (kind() === 'seek') {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M6.7 7.2A7.5 7.5 0 1 0 12 5M14.5 2.5 12 5l2.5 2.5'" />
          <text x="12" y="15.2" class="ten">10</text>
        </svg>
      } @else {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M7 6v12M18 6.5v11L9.5 12z'" />
        </svg>
      }
    </button>
    <button
      type="button"
      class="round big"
      [attr.data-action]="'toggle'"
      [attr.aria-label]="toggleLabel()"
      [disabled]="!store.canSend()"
      (click)="playPause.emit()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path [attr.d]="'M7 5.5v13L17.5 12z'" class="solid" />
      </svg>
    </button>
    <button
      type="button"
      class="round"
      [attr.data-action]="'next'"
      [attr.aria-label]="nextLabel()"
      [disabled]="!store.canSend()"
      (click)="next.emit()"
    >
      @if (kind() === 'seek') {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M17.3 7.2A7.5 7.5 0 1 1 12 5M9.5 2.5 12 5 9.5 7.5'" />
          <text x="12" y="15.2" class="ten">10</text>
        </svg>
      } @else {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M17 6v12M6 6.5v11L14.5 12z'" />
        </svg>
      }
    </button>
  `,
  styleUrl: './transport.css',
})
export class PcTransport {
  protected readonly store = inject(PcStore);
  readonly kind = input<TransportKind>('track');
  readonly previousLabel = input.required<string>();
  readonly toggleLabel = input.required<string>();
  readonly nextLabel = input.required<string>();
  readonly previous = output<void>();
  readonly playPause = output<void>();
  readonly next = output<void>();
}
