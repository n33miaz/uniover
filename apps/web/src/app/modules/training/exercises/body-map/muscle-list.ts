import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { MuscleId } from '../../domain/taxonomy';

export interface MuscleListItem {
  readonly id: MuscleId;
  readonly label: string;
  /** Quantos exercícios têm o músculo como principal. */
  readonly count: number;
  /** A palavra depois do número ("exercícios"): só o leitor de tela a ouve, e o nome do botão fica "Peitoral 41 exercícios". */
  readonly unit: string;
  readonly selected: boolean;
}

export interface MuscleListGroup {
  readonly id: string;
  readonly label: string;
  readonly muscles: readonly MuscleListItem[];
}

/**
 * A lista de todos os músculos da taxonomia, por grupo, com a contagem de exercícios de cada. É o caminho completo para quem
 * não acerta a figura, não a enxerga ou usa só o teclado: toda zona do desenho tem aqui o seu botão (e os músculos que não
 * têm zona também). Cada botão tem 44 px de altura de toque, com a pílula de 36 px desenhada dentro, como os chips da lista
 * de Exercícios.
 */
@Component({
  selector: 'app-muscle-list',
  templateUrl: './muscle-list.html',
  styleUrl: './muscle-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuscleList {
  readonly groups = input.required<readonly MuscleListGroup[]>();
  readonly picked = output<MuscleId>();
}
