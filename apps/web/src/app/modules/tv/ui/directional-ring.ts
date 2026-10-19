import { Component } from '@angular/core';
import { KeyButton } from '../input/key-button';
import { TvIcon } from './tv-icon';

/**
 * Anel direcional: quatro setores (cada um com a área de toque do anel inteiro, recortada em triângulo) e o OK
 * redondo no centro. A borda é um degradê da cor de destaque da paleta ativa. Os setores são botões de verdade,
 * então teclado e leitor de tela os alcançam; segurar uma seta repete a tecla.
 */
@Component({
  selector: 'app-directional-ring',
  imports: [KeyButton, TvIcon],
  templateUrl: './directional-ring.html',
  styleUrl: './directional-ring.css',
})
export class DirectionalRing {}
