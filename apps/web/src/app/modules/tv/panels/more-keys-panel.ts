import { Component, inject } from '@angular/core';
import { KeyButton } from '../input/key-button';
import { TvRoundKeys } from '../data/tv-round-keys';
import { TvIcon } from '../ui/tv-icon';

/**
 * Painel "Mais botões": as teclas que a TV tem e que Personalizar deixou fora da tela principal. Cada uma é uma tecla de
 * verdade (mesma `appKey` do controle): tocar manda a tecla e o painel continua aberto, para apertar mais de uma.
 */
@Component({
  selector: 'app-tv-more-keys',
  imports: [KeyButton, TvIcon],
  templateUrl: './more-keys-panel.html',
  styleUrl: './more-keys-panel.css',
})
export class MoreKeysPanel {
  protected readonly keys = inject(TvRoundKeys);
}
