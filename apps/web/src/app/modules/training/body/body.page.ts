import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TrainingSoon } from '../shell/training-soon';

/** Aba Corpo, provisória: peso, medidas e calorias ainda não existem. */
@Component({
  selector: 'app-training-body-page',
  imports: [TrainingSoon],
  template: `<app-training-soon [heading]="heading" [text]="text" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyPage {
  protected readonly heading = $localize`:@@training.body.title:Corpo`;
  protected readonly text = $localize`:@@training.body.soon:Em construção.`;
}
