import { Component, input, output } from '@angular/core';

/** O aviso no centro da tela quando a TV perdeu o pareamento: só o administrador tem a ação de parear de novo. */
@Component({
  selector: 'app-tv-pairing-notice',
  templateUrl: './pairing-notice.html',
  styleUrl: './pairing-notice.css',
})
export class PairingNotice {
  /** Quem administra o app é quem pode parear a TV; as outras contas só sabem a quem pedir. */
  readonly owner = input.required<boolean>();
  readonly pair = output<void>();
}
