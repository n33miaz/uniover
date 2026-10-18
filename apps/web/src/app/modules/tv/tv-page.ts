import { Component } from '@angular/core';
import { PageHeader } from '../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-tv-page',
  imports: [PageHeader],
  template: `<app-page-header [heading]="title" />`,
})
export class TvPage {
  protected readonly title = $localize`:@@tv.title:TV`;
}
