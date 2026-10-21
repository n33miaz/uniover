import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TrainingSoon } from '../shell/training-soon';

/** Aba Hoje, provisória: o treino do dia ainda não existe. Leva ao que já funciona para a tela não ser um beco. */
@Component({
  selector: 'app-training-today-page',
  imports: [RouterLink, TrainingSoon],
  template: `
    <app-training-soon [heading]="heading" [text]="text">
      <a class="primary ui-btn" routerLink="/treino/rotinas" i18n="@@training.today.routines"
        >Montar rotinas</a
      >
      <a class="secondary ui-btn" routerLink="/treino/exercicios" i18n="@@training.today.exercises"
        >Ver exercícios</a
      >
    </app-training-soon>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TodayPage {
  protected readonly heading = $localize`:@@training.today.title:Hoje`;
  protected readonly text = $localize`:@@training.today.soon:Em construção: aqui vai aparecer o treino do dia. Enquanto isso, monte suas rotinas e veja o catálogo.`;
}
