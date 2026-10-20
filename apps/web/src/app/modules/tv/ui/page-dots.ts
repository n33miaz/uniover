import { Component, computed, input, output } from '@angular/core';

/**
 * Pontos de paginação do controle. Cada ponto é pequeno (8 px) e a área de toque tem 44 px. O ponto da página à
 * vista leva `aria-current`; a cor sozinha não informa. Um grupo só, parado embaixo do palco que troca de página.
 * O indicador (a pílula de destaque) acompanha a posição fracionária da rolagem (`progress`): durante o arrasto ela
 * anda junto com o dedo e se alonga entre dois pontos, e ao soltar chega ao ponto da página sem saltar.
 */
@Component({
  selector: 'app-page-dots',
  template: `
    <div
      class="dots"
      role="group"
      aria-label="Páginas do controle"
      i18n-aria-label="@@tv.pager.label"
      (keydown)="onKey($event)"
    >
      @for (index of indexes(); track index) {
        <button
          type="button"
          class="dot"
          [attr.aria-label]="label(index)"
          [attr.aria-current]="current() === index ? 'true' : null"
          (click)="choose.emit(index)"
        >
          <span class="mark"></span>
        </button>
      }
      <span class="thumb" aria-hidden="true" [style.--x]="thumb().x" [style.--w]="thumb().w"></span>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      align-self: center;
    }
    .dots {
      position: relative;
      display: flex;
    }
    .dot {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    /* Cor cheia (sem opacidade): o ponto de uma página fora de vista precisa de 3:1 contra o fundo. */
    .mark {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a-ink3);
    }
    @media (prefers-reduced-motion: no-preference) {
      .mark {
        transition: transform 0.15s ease;
      }
      .dot:active .mark {
        transform: scale(1.4);
      }
    }
    /* O destaque anda por cima dos pontos; o toque passa direto para o botão que está embaixo. */
    .thumb {
      position: absolute;
      top: 17px;
      left: 0;
      width: var(--w, 10px);
      height: 10px;
      border-radius: 5px;
      background: var(--a-accent);
      pointer-events: none;
      transform: translateX(var(--x, 17px));
    }
    .dot:focus-visible {
      border-radius: 12px;
      outline: 3px solid var(--a-accent);
      outline-offset: -6px;
    }
    @media (forced-colors: active) {
      .thumb {
        background: Highlight;
      }
    }
  `,
})
export class PageDots {
  /** Página à vista (a primeira é 0). */
  readonly current = input.required<number>();
  /** Posição fracionária da rolagem (0 a count-1); sem ela o destaque fica no ponto da página à vista. */
  readonly progress = input<number | null>(null);
  readonly count = input(2);
  readonly choose = output<number>();

  /** Setas esquerda e direita trocam de página com o foco nos pontos (a alternativa ao gesto de deslizar). */
  protected onKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    const target = this.current() + step;
    if (target < 0 || target >= this.count()) return;
    event.preventDefault();
    this.choose.emit(target);
  }

  /** Destaque: esquerda e largura em px; alonga até 34 px a meio caminho entre dois pontos. */
  protected readonly thumb = computed(() => {
    const position = this.progress() ?? this.current();
    const fraction = position - Math.floor(position);
    const stretch = 1 - Math.abs(2 * fraction - 1);
    const width = 10 + 24 * stretch;
    const centre = 22 + 44 * position;
    return { x: `${centre - width / 2}px`, w: `${width}px` };
  });

  protected indexes(): number[] {
    return Array.from({ length: this.count() }, (_, index) => index);
  }

  protected label(index: number): string {
    const number = index + 1;
    const total = this.count();
    return $localize`:@@tv.pager.page:Página ${number}:number: de ${total}:total:`;
  }
}
