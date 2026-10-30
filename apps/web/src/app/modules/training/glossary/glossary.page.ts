import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BackNavigation } from '../shell/back-navigation';
import { TrainingGlyph } from '../shell/training-glyph';

/** Referência curta dos nomes do Treino, aberta sem acrescentar explicações às telas principais. */
@Component({
  selector: 'app-training-glossary-page',
  imports: [RouterLink, TrainingGlyph],
  templateUrl: './glossary.page.html',
  styleUrl: './glossary.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingGlossaryPage {
  private readonly back = inject(BackNavigation);

  protected goBack(): void {
    this.back.back('/treino');
  }
}
