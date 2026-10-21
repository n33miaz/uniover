import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Seletor "Catálogo | Rotinas" do topo da aba Exercícios. São duas telas (rotas), então é navegação: dois links, com
 * `aria-current` no que está aberto. O visual é o de controle segmentado.
 */
@Component({
  selector: 'app-exercises-switch',
  imports: [RouterLink],
  template: `
    <nav class="seg" aria-label="Catálogo ou rotinas" i18n-aria-label="@@training.switch.label">
      <a
        routerLink="/treino/exercicios"
        [attr.aria-current]="current() === 'catalog' ? 'page' : null"
        i18n="@@training.switch.catalog"
        >Catálogo</a
      >
      <a
        routerLink="/treino/rotinas"
        [attr.aria-current]="current() === 'routines' ? 'page' : null"
        i18n="@@training.switch.routines"
        >Rotinas</a
      >
    </nav>
  `,
  styleUrl: './exercises-switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExercisesSwitch {
  readonly current = input.required<'catalog' | 'routines'>();
}
