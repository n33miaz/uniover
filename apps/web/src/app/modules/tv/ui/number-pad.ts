import { Component } from '@angular/core';
import { TvKey } from '../data/tv-types';
import { KeyButton } from '../input/key-button';
import { TvIcon } from './tv-icon';

interface Digit {
  readonly key: TvKey;
  readonly digit: string;
}

/**
 * Teclado numérico do controle: 1 a 9 em três colunas e, embaixo, "Origem" (que só abre o seletor da TV) e o 0,
 * que ocupa as duas colunas restantes. Enche a janela do palco (medidas em unidades `cq*`) até um teto, para não
 * esticar em telas largas.
 */
@Component({
  selector: 'app-number-pad',
  imports: [KeyButton, TvIcon],
  templateUrl: './number-pad.html',
  styleUrl: './number-pad.css',
})
export class NumberPad {
  protected readonly digits: readonly Digit[] = [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '0',
  ].map((digit) => ({ key: `NUM_${digit}` as TvKey, digit }));

  protected label(digit: string): string {
    return $localize`:@@tv.key.number:Número ${digit}:digit:`;
  }
}
