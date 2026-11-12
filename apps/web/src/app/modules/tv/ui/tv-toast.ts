import { Component, input } from '@angular/core';
import type { TvNotice } from '../data/tv-store';

/**
 * Aviso passageiro da tela da TV: flutua logo abaixo do cabeçalho (ou da linha do motivo, quando ela existe) sem
 * pegar o toque. O erro usa `role="alert"` e a cor de erro; o resto é um recado calmo (`role="status"`). A saída (`animate.leave`) segura o
 * elemento até o fim da animação, por isso a decisão de mostrar ou não fica aqui dentro.
 */
@Component({
  selector: 'app-tv-toast',
  templateUrl: './tv-toast.html',
  styleUrl: './tv-toast.css',
})
export class TvToast {
  /** O aviso a mostrar; `null` não mostra nada. */
  readonly notice = input.required<TvNotice | null>();
}
