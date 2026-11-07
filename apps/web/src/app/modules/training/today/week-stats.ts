import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Os três números da semana (treinos, séries e volume). Ficam sempre na tela: enquanto a semana é lida, um traço guarda o
 * lugar, sem salto de altura.
 */
@Component({
  selector: 'app-week-stats',
  templateUrl: './week-stats.html',
  styleUrl: './week-stats.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WeekStats {
  /** A semana já foi lida: antes disso os números são um traço. */
  readonly ready = input.required<boolean>();
  readonly sessions = input.required<number>();
  readonly sets = input.required<number>();
  /** O volume já formatado ("600 kg"). */
  readonly volume = input.required<string>();
}
