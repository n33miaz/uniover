import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TrainingSoon } from '../shell/training-soon';

/** Aba Progresso, provisória: os gráficos e recordes ainda não existem. */
@Component({
  selector: 'app-training-progress-page',
  imports: [TrainingSoon],
  template: `<app-training-soon [heading]="heading" [text]="text" [glyph]="'chart'" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressPage {
  protected readonly heading = $localize`:@@training.progress.title:Progresso`;
  protected readonly text = $localize`:@@training.progress.soon:Em construção.`;
}
