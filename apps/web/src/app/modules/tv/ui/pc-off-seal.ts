import { Component, input, output } from '@angular/core';
import { PcOffIcon } from './pc-off-icon';

/** O selo no centro da tela quando o PC está confirmado desligado: o aviso, desde quando e o botão de tentar de novo. */
@Component({
  selector: 'app-tv-pc-off-seal',
  imports: [PcOffIcon],
  templateUrl: './pc-off-seal.html',
  styleUrl: './pc-off-seal.css',
})
export class PcOffSeal {
  /** Desde quando o PC está desligado, já formatado; `null` quando não se sabe. */
  readonly since = input<string | null>(null);
  /** Uma nova tentativa está em andamento: o botão fica desligado. */
  readonly retrying = input(false);
  readonly retry = output<void>();
}
