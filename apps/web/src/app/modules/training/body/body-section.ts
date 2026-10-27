import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';
import { BodyGlyph, type BodyGlyphName } from './body-glyph';

let nextSectionId = 0;

/**
 * Seção que se abre, no mesmo desenho das da tela de Progresso: uma linha de 60 px com ícone, título e o resumo do que há
 * dentro (o número que importa já aparece fechada), e o conteúdo logo abaixo quando aberta. O título é um `h3` com o botão
 * dentro (o padrão de acordeão acessível).
 */
@Component({
  selector: 'app-body-section',
  imports: [BodyGlyph, TrainingGlyph],
  template: `
    <h3 class="head">
      <button
        type="button"
        class="toggle ui-row"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="bodyId"
        (click)="open.set(!open())"
      >
        <span class="ui-tile"><app-body-glyph [name]="glyph()" /></span>
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
      <div class="ui-collapse">
        <div class="ui-collapse-inner">
          <div class="body" [id]="bodyId">
            <ng-content />
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
    }
    /* O botão preenche a faixa até a borda: o contorno de foco vai por dentro, onde o grupo não o corta. */
    .toggle:focus-visible {
      outline-offset: -3px;
    }
    /* Título numa linha só: "Medidas e Gordura Corporal" cabe no iPhone de 390 px reduzindo a letra aos poucos. */
    .ui-row-title {
      font-size: clamp(0.9rem, 3.8vw, 1rem);
    }
    .chevron {
      color: var(--a-ink2);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-1) var(--space-4) var(--space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodySection {
  readonly heading = input.required<string>();
  /** O que há dentro, em uma linha ("16,9 % · Marinha · 11/10"); vazio some. */
  readonly summary = input<string>('');
  readonly glyph = input.required<BodyGlyphName>();
  readonly open = model(false);

  protected readonly bodyId = `body-section-${nextSectionId++}`;
}
