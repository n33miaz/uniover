import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { remoteServiceHints } from '../data/tv-status';

const LAST_STEP = 3;

/** Passos de configuração da TV, sem enviar comandos ou supor que uma falha do serviço foi diagnosticada pelo app. */
@Component({
  selector: 'app-tv-setup-guide-page',
  imports: [RouterLink],
  templateUrl: './setup-guide.page.html',
  styleUrl: './setup-guide.page.css',
})
export class SetupGuidePage {
  private readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  protected readonly step = signal(0);
  protected readonly hints = remoteServiceHints();

  protected next(): void {
    this.moveTo(Math.min(LAST_STEP, this.step() + 1));
  }

  protected previous(): void {
    this.moveTo(Math.max(0, this.step() - 1));
  }

  private moveTo(step: number): void {
    if (step === this.step()) return;
    this.step.set(step);
    afterNextRender(() => this.heading()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }
}
