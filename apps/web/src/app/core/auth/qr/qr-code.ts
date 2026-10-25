import { Component, computed, input } from '@angular/core';
import { qrDrawing } from './qr-path';

/** Zona de silêncio exigida pelo padrão do QR: 4 módulos em volta, sempre brancos. */
const QUIET_ZONE = 4;

/**
 * QR desenhado no próprio navegador (nada vai a um serviço de fora). Escuro sobre branco em qualquer tema: muitos
 * leitores não entendem um QR invertido, então ele não segue o modo escuro do app.
 */
@Component({
  selector: 'app-qr-code',
  templateUrl: './qr-code.html',
  styleUrl: './qr-code.css',
})
export class QrCode {
  readonly value = input.required<string>();
  /** O que o leitor de tela diz no lugar da imagem. */
  readonly label = input.required<string>();

  protected readonly drawing = computed(() => qrDrawing(this.value()));
  protected readonly viewBox = computed(() => {
    const side = this.drawing().size + QUIET_ZONE * 2;
    return `${-QUIET_ZONE} ${-QUIET_ZONE} ${side} ${side}`;
  });
  protected readonly extent = computed(() => this.drawing().size + QUIET_ZONE * 2);
  protected readonly origin = -QUIET_ZONE;
}
