import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';

/** A sugestão do dia: a carga e a faixa de repetições, com o motivo em uma frase. */
export interface Tip {
  readonly text: string;
  readonly reason: string;
}

/**
 * Última vez e sugestão do dia, em duas linhas calmas. O motivo da sugestão fica atrás do "i" (informação secundária atrás
 * de um toque). Na primeira vez que o exercício é feito não há o que sugerir, e a linha diz isso em vez de ficar muda.
 */
@Component({
  selector: 'app-focus-hint',
  imports: [TrainingGlyph],
  template: `
    <section class="hint" aria-labelledby="hint-title">
      <h3 id="hint-title" class="ui-visually-hidden" i18n="@@training.live.hint-title">
        Última Vez e Sugestão
      </h3>
      @if (last(); as value) {
        <p class="line">
          <span class="key" i18n="@@training.live.last">Última vez</span>&ngsp;
          <b>{{ value }}</b>
        </p>
      }
      @if (tip(); as current) {
        <p class="line">
          <span class="key" i18n="@@training.live.suggestion">Sugestão do dia</span>&ngsp;
          <b>{{ current.text }}</b>
          <button
            type="button"
            class="why ui-tap"
            [attr.aria-expanded]="reasonOpen()"
            [attr.aria-label]="whyLabel"
            (click)="reasonOpen.set(!reasonOpen())"
          >
            <app-training-glyph name="info" />
          </button>
        </p>
        @if (reasonOpen()) {
          <p class="reason">{{ current.reason }}</p>
        }
      } @else if (firstTime()) {
        <p class="line">
          <span class="key" i18n="@@training.live.first-time"
            >Primeira vez neste exercício: sem sugestão.</span
          >
        </p>
      }
    </section>
  `,
  styleUrl: './focus-hint.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FocusHint {
  readonly last = input<string | null>(null);
  readonly tip = input<Tip | null>(null);
  readonly firstTime = input(false);

  protected readonly reasonOpen = signal(false);
  protected readonly whyLabel = $localize`:@@training.live.why:Por que esta sugestão?`;
}
