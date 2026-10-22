import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { MuscleId } from '../../domain/taxonomy';
import { BODY_DETAILS, BODY_HEIGHT, BODY_OUTLINE, BODY_WIDTH, BodyFace } from './body-zones';
import type { Intensity } from './muscle-intensity';

/** O que a figura precisa saber de cada zona para desenhá-la (a tela monta isto a partir da face, do volume e da escolha). */
export interface FigureZone {
  readonly muscle: MuscleId;
  /** O que se vê: contorno e preenchimento. */
  readonly shapes: readonly string[];
  /** A área de toque (retângulos que não se sobrepõem). */
  readonly tiles: readonly string[];
  readonly level: Intensity;
  /** Texto lido pelo leitor de tela: o músculo, quantos exercícios e quantas séries na semana. */
  readonly label: string;
  readonly selected: boolean;
}

/**
 * A silhueta do corpo com as zonas dos músculos. Cada zona é um botão (papel, foco e teclado) feito de formas SVG: a
 * cor de intensidade e o contorno mais grosso do selecionado são classes e atributos de dado, nunca `style`. O toque cai
 * em retângulos invisíveis maiores que a forma (ver `body-zones.ts`); o dedo não precisa acertar o músculo.
 */
@Component({
  selector: 'app-body-figure',
  templateUrl: './body-figure.html',
  styleUrl: './body-figure.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyFigure {
  readonly zones = input.required<readonly FigureZone[]>();
  readonly face = input<BodyFace>('front');
  /** Nome da figura para o leitor de tela ("Corpo, de frente"). */
  readonly label = input.required<string>();
  readonly picked = output<MuscleId>();

  protected readonly outline = BODY_OUTLINE;
  protected readonly details = BODY_DETAILS;
  protected readonly viewBox = `0 0 ${BODY_WIDTH} ${BODY_HEIGHT}`;

  /** Enter e Espaço escolhem a zona; o Espaço não pode rolar a página. */
  protected activate(event: Event, muscle: MuscleId): void {
    event.preventDefault();
    this.picked.emit(muscle);
  }
}
