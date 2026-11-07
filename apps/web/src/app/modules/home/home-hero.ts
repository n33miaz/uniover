import { Component, input } from '@angular/core';
import { Skeleton } from '../../shared/ui/skeleton/skeleton';
import { HomeGlyph } from './home-glyph';

/**
 * Saudação da Início: a faixa com a data, o cumprimento e a hora, e a cena da parte do dia desenhada ao fundo. É só
 * apresentação: o que ela mostra vem pronto da página, e o `<header>` interno continua sendo o item da coluna da Início.
 */
@Component({
  selector: 'app-home-hero',
  imports: [HomeGlyph, Skeleton],
  templateUrl: './home-hero.html',
  styleUrl: './home-hero.css',
})
export class HomeHero {
  /** A leitura do estado ainda não chegou: formas no lugar do texto. */
  readonly loading = input.required<boolean>();
  readonly dayPart = input.required<'morning' | 'afternoon' | 'evening'>();
  readonly dateLabel = input.required<string>();
  readonly greeting = input.required<string>();
  readonly time = input.required<string>();
}
