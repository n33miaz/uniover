import { Component, input } from '@angular/core';

export type IconName = 'tv' | 'activity' | 'up' | 'down' | 'grip';

// Traços simples desenhados para o app (24x24, contorno). Decorativos: o texto do botão ou do bloco é que informa.
const PATHS: Record<IconName, string> = {
  tv: 'M3 6h18v11H3z M8 21h8 M12 17v4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
};

@Component({
  selector: 'app-icon',
  template: `
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();

  protected path(): string {
    return PATHS[this.name()];
  }
}
