import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

/** Padrão de vibração do fim do descanso: toque, pausa, toque. */
export const REST_VIBRATION: readonly number[] = [200, 100, 200];

/**
 * Aviso do fim do descanso: só vibração, quando o aparelho a tem. O iPhone não expõe `navigator.vibrate`; nesse caso
 * o cartão e a região ARIA da tela comunicam o fim. Nunca cria nem toca áudio.
 */
@Injectable()
export class RestAlert {
  private readonly win = inject(DOCUMENT).defaultView;

  /** Avisa que o descanso acabou: vibra se der. */
  fire(): void {
    try {
      this.win?.navigator.vibrate?.([...REST_VIBRATION]);
    } catch {
      // Sem vibração (ou recusada): segue sem ela.
    }
  }
}
