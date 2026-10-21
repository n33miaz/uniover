import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TrainingSoon } from '../../shell/training-soon';

/** Mapa do corpo, provisório: o desenho e a escolha do músculo ainda não existem. */
@Component({
  selector: 'app-training-body-map-page',
  imports: [RouterLink, TrainingSoon],
  template: `
    <app-training-soon [heading]="heading" [text]="text" [glyph]="'target'">
      <a class="secondary ui-btn" routerLink="/treino/exercicios" i18n="@@training.map.back"
        >Voltar aos exercícios</a
      >
    </app-training-soon>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMapPage {
  protected readonly heading = $localize`:@@training.map.title:Mapa do corpo`;
  protected readonly text = $localize`:@@training.map.soon:Em construção.`;
}
