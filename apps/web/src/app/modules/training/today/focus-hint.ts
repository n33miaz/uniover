import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';

/** A sugestão do dia: a carga e a faixa de repetições, com o motivo em uma frase. */
export interface Tip {
  readonly text: string;
  readonly reason: string;
}

let nextHintId = 0;

/**
 * "Última vez e sugestão", recolhido atrás de um toque: o registro da série é o que importa na tela, e a referência só abre
 * quando a pessoa quer. Aberto, mostra as duas linhas; o motivo da sugestão fica atrás do "i". Na primeira vez que o
 * exercício é feito não há o que sugerir, e a linha diz isso em vez de ficar muda.
 */
@Component({
  selector: 'app-focus-hint',
  imports: [TrainingGlyph],
  template: `
    <section class="hint">
      <button
        type="button"
        class="toggle"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="panelId"
        (click)="toggle()"
      >
        <span i18n="@@training.live.hint-title">Última Vez e Sugestão</span>
        <app-training-glyph class="chevron" name="down" />
      </button>
      <!-- O painel fica na página, escondido quando recolhido: o aria-controls do botão sempre aponta para ele. -->
      <div class="panel" [id]="panelId" [hidden]="!open()">
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
              [attr.aria-controls]="reasonId"
              [attr.aria-label]="whyLabel"
              (click)="reasonOpen.set(!reasonOpen())"
            >
              <app-training-glyph name="info" />
            </button>
          </p>
          <p class="reason" [id]="reasonId" [hidden]="!reasonOpen()">{{ current.reason }}</p>
        } @else if (firstTime()) {
          <p class="line">
            <span class="key" i18n="@@training.live.first-time"
              >Primeira vez neste exercício: sem sugestão.</span
            >
          </p>
        }
      </div>
    </section>
  `,
  styleUrl: './focus-hint.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FocusHint {
  readonly last = input<string | null>(null);
  readonly tip = input<Tip | null>(null);
  readonly firstTime = input(false);

  protected readonly open = signal(false);
  protected readonly reasonOpen = signal(false);
  protected readonly panelId = `hint-panel-${nextHintId}`;
  protected readonly reasonId = `hint-reason-${nextHintId++}`;
  /** Recolher o painel também recolhe o motivo: ao abrir de novo a referência volta como estava no começo. */
  protected toggle(): void {
    if (this.open()) this.reasonOpen.set(false);
    this.open.update((open) => !open);
  }

  protected readonly whyLabel = $localize`:@@training.live.why:Por que esta sugestão?`;
}
