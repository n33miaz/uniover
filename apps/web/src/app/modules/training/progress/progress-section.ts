import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';
import { ProgressGlyph, ProgressGlyphName } from './progress-glyph';

let nextSectionId = 0;

/**
 * Seção que se abre: uma linha de 60 px com ícone, título e o resumo do que há dentro (o número que importa já aparece
 * fechada), e o conteúdo logo abaixo quando aberta. É o jeito de a tela de Progresso caber em poucas rolagens: o gráfico
 * fica sempre à vista e o resto espera um toque. O título é um `h3` com o botão dentro (o padrão de acordeão acessível).
 */
@Component({
  selector: 'app-progress-section',
  imports: [ProgressGlyph, TrainingGlyph],
  template: `
    <h3 class="head">
      <button
        type="button"
        class="toggle ui-row"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="bodyId"
        (click)="open.set(!open())"
      >
        <span class="ui-tile"><app-progress-glyph [name]="glyph()" /></span>
        <span class="ui-row-text">
          <span class="ui-row-title">{{ heading() }}</span>
          @if (summary()) {
            <span class="ui-row-sub">{{ summary() }}</span>
          }
        </span>
        <app-training-glyph class="chevron" [name]="open() ? 'up' : 'down'" />
      </button>
    </h3>
    @if (open()) {
      <div class="ui-collapse" [animate.leave]="'leaving'">
        <div class="ui-collapse-inner">
          <div class="body" [id]="bodyId">
            <ng-content />
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './progress-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressSection {
  readonly heading = input.required<string>();
  /** O que há dentro, em uma linha ("3 treinos · 54 séries"); vazio some. */
  readonly summary = input<string>('');
  readonly glyph = input.required<ProgressGlyphName>();
  readonly open = model(false);

  protected readonly bodyId = `progress-section-${nextSectionId++}`;
}
