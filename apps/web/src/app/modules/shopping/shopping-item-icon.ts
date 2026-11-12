import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { categoryOf, itemEmoji, type CategoryKey } from './shopping-categories';

// Um desenho por categoria, em grade de 24, só traço: leve, do próprio app e sem sinal nenhum.
const DRAWINGS: Record<CategoryKey, string> = {
  // Folha.
  hortifruti: 'M5 19c0-8 5-13 14-14 0 9-5 14-13 14z M5 19l8-8',
  // Pão de forma.
  padaria: 'M6 10a4 4 0 0 1 0-6h12a4 4 0 0 1 0 6v9H6z M10 13v3 M14 13v3',
  // Pote com tampa.
  mercearia: 'M7 8h10v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z M6 5h12v3H6z M10 13h4',
  // Coxa de frango.
  carnes: 'M14 4a6 6 0 0 1 4 10l-3 1-5 5a2 2 0 1 1-3-3l5-5 1-3a6 6 0 0 1 1-5z',
  // Caixa de leite.
  laticinios: 'M8 8l2-4h4l2 4v12H8z M8 8h8 M11 12h2',
  // Floco de neve.
  congelados: 'M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M10 4.5l2 2 2-2 M10 19.5l2-2 2 2',
  // Garrafa.
  bebidas: 'M10 3h4v4l2 3v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10l2-3z M8 13h8',
  // Borrifador.
  limpeza: 'M8 10h6l1 10H7z M9 10V7h4v3 M13 7h4l1 2 M17 5h2',
  // Gota.
  higiene:
    'M12 3.5c3.5 4.5 5.5 7.5 5.5 10.5a5.5 5.5 0 0 1-11 0c0-3 2-6 5.5-10.5z M10 15a2 2 0 0 0 2 2',
  // Mamadeira.
  bebe: 'M10 3h4v3h-4z M9 6h6l1 3v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9z M8 12h3 M8 15h3',
  // Pata.
  pet: 'M12 13c3 0 5 3 5 5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2c0-2 2-5 5-5z M6 9.5a1.5 1.5 0 1 0 0 .1 M18 9.5a1.5 1.5 0 1 0 0 .1 M9.5 6a1.5 1.5 0 1 0 0 .1 M14.5 6a1.5 1.5 0 1 0 0 .1',
  // Sacola.
  outros: 'M5 8h14l-1 12H6z M9 8V6a3 3 0 0 1 6 0v2',
};

/** O desenho de uma categoria (para os chips de escolher categoria). */
export function categoryDrawing(key: CategoryKey): string {
  return DRAWINGS[key];
}

/**
 * O "jeito" de um item na lista: o emoji de um item comum (leite, banana) ou, sem ele, o desenho da categoria. Decorativo:
 * o nome ao lado é que informa.
 */
@Component({
  selector: 'app-shopping-item-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[attr.data-category]': 'category()' },
  template: `
    @if (emoji(); as glyph) {
      <span class="emoji">{{ glyph }}</span>
    } @else {
      <svg viewBox="0 0 24 24" focusable="false"><path [attr.d]="drawing()" /></svg>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      background: var(--a-accent-soft);
      color: var(--a-accent);
    }
    .emoji {
      font-size: 1.25rem;
      line-height: 1;
    }
    svg {
      width: 20px;
      height: 20px;
    }
    path {
      fill: none;
      stroke: currentColor;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `,
})
export class ShoppingItemIcon {
  readonly product = input.required<{ readonly name: string; readonly section: string }>();

  protected readonly category = computed(() => categoryOf(this.product()));
  protected readonly emoji = computed(() => itemEmoji(this.product().name));
  protected readonly drawing = computed(() => DRAWINGS[this.category()]);
}
