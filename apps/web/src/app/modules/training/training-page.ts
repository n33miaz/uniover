import { Component } from '@angular/core';
import { PageHeader } from '../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-training-page',
  imports: [PageHeader],
  template: `<app-page-header [heading]="title" />`,
})
export class TrainingPage {
  protected readonly title = $localize`:@@training.title:Treino`;
}
