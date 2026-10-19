import { Component, input, output } from '@angular/core';

/**
 * Pontos de paginação do controle. Cada ponto é pequeno (10 px) e a área de toque tem 44 px. O ponto da página à
 * vista leva `aria-current`; a cor sozinha não informa. Cada página do carrossel mostra o seu grupo, para quem está
 * na segunda ter o caminho de volta ao lado do conteúdo.
 */
@Component({
  selector: 'app-page-dots',
  template: `
    <div
      class="dots"
      role="group"
      aria-label="Páginas do controle"
      i18n-aria-label="@@tv.pager.label"
    >
      @for (index of indexes(); track index) {
        <button
          type="button"
          class="dot"
          [attr.aria-label]="label(index)"
          [attr.aria-current]="current() === index ? 'true' : null"
          (click)="choose.emit(index)"
        >
          <span class="mark" [class.on]="current() === index"></span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      align-self: center;
    }
    .dots {
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
    .mark {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--a-ink3);
      opacity: 0.55;
    }
    .mark.on {
      background: var(--a-accent);
      opacity: 1;
    }
  `,
})
export class PageDots {
  /** Página à vista (a primeira é 0). */
  readonly current = input.required<number>();
  readonly count = input(2);
  readonly choose = output<number>();

  protected indexes(): number[] {
    return Array.from({ length: this.count() }, (_, index) => index);
  }

  protected label(index: number): string {
    const number = index + 1;
    const total = this.count();
    return $localize`:@@tv.pager.page:Página ${number}:number: de ${total}:total:`;
  }
}
