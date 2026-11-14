import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TvHelpGuides } from '../data/tv-help-guides';
import { TvIcon } from './tv-icon';

/**
 * O conteúdo da folha "Ajuda" (vai dentro de um `TvPanel`): uma linha para cada guia que a conta pode abrir. Abrir um guia
 * leva a outra tela, que desmonta a do controle e com ela esta folha.
 */
@Component({
  selector: 'app-tv-help',
  imports: [RouterLink, TvIcon],
  template: `
    <div class="ui-group">
      @for (guide of guides.list(); track guide.route) {
        <a class="ui-row" [routerLink]="guide.route">
          <span class="ui-tile"><app-tv-icon name="info" /></span>
          <span class="ui-row-text">
            <span class="ui-row-title">{{ guide.label }}</span>
          </span>
        </a>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class TvHelp {
  protected readonly guides = inject(TvHelpGuides);
}
