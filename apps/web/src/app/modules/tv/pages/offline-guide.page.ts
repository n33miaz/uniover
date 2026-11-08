import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * "Se a internet cair": o passo a passo, só texto, de quando a TV deixa de responder pelo app porque a internet de casa
 * caiu. Dois casos: só a internet do provedor caiu (o PC ganha internet pelo celular, por cabo) ou o roteador desligou (o
 * celular cria uma rede com o mesmo nome e a mesma senha do Wi-Fi de casa, e os aparelhos entram sozinhos). Não manda
 * nenhum comando à TV e não pede para trocar nenhuma senha: a rede do celular é que copia a de casa.
 */
@Component({
  selector: 'app-tv-offline-guide-page',
  imports: [RouterLink],
  templateUrl: './offline-guide.page.html',
  styleUrl: './offline-guide.page.css',
})
export class OfflineGuidePage {}
