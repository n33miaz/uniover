import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TrainingGlyph, TrainingGlyphName } from './training-glyph';

let nextSoonId = 0;

/**
 * Cartão calmo das telas do módulo que ainda não existem ("Em construção"): um ícone, o título e uma frase. Cada tela
 * provisória o usa até ser substituída pela definitiva; o que for projetado vira as ações do cartão.
 */
@Component({
  selector: 'app-training-soon',
  imports: [TrainingGlyph],
  template: `
    <section class="soon ui-card" [attr.aria-labelledby]="titleId">
      <span class="ui-tile lg"><app-training-glyph [name]="glyph()" /></span>
      <h2 [id]="titleId">{{ heading() }}</h2>
      <p>{{ text() }}</p>
      <div class="actions"><ng-content /></div>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .soon {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      max-width: 40rem;
      margin-inline: auto;
      padding: var(--space-6) var(--space-4);
      text-align: center;
    }
    h2 {
      font-size: var(--fs-title);
      font-weight: 750;
      letter-spacing: -0.01em;
    }
    p {
      margin: 0;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--space-2);
    }
    .actions:empty {
      display: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSoon {
  readonly heading = input.required<string>();
  readonly text = input.required<string>();
  readonly glyph = input<TrainingGlyphName>('dumbbell');
  protected readonly titleId = `training-soon-title-${nextSoonId++}`;
}
