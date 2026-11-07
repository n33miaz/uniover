import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';
import { TodayGlyph } from './today-glyph';

/** O recorde que acabou de sair: um aviso quente e curto, com as linhas do que foi batido e um botão para dispensar. */
@Component({
  selector: 'app-live-record-banner',
  imports: [TrainingGlyph, TodayGlyph],
  templateUrl: './live-record-banner.html',
  styleUrl: './live-record-banner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveRecordBanner {
  /** O que foi batido, uma frase por linha. */
  readonly lines = input.required<readonly string[]>();
  /** Tocaram em dispensar: quem mostra o aviso decide o que fazer com ele. */
  readonly dismissed = output<void>();

  protected readonly dismissLabel = $localize`:@@training.live.record-dismiss:Dispensar o aviso de recorde`;
}
