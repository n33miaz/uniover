import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Licença da ilustração (CC BY-SA 4.0), como a Creative Commons recomenda: título, autor, fonte e licença. */
export const ART_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/** Crédito curto que fica junto da ilustração, com link para a licença e para a tela de Créditos. */
@Component({
  selector: 'app-exercise-credit-line',
  imports: [RouterLink],
  templateUrl: './exercise-credit-line.html',
  styleUrl: './exercise-credit-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseCreditLine {
  protected readonly licenseUrl = ART_LICENSE_URL;
  /** Link que sai do app: sem acesso à janela de origem e sem referência. */
  protected readonly linkRel = 'noopener noreferrer';
}
