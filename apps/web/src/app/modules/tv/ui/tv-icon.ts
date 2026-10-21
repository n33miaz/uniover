import { Component, input } from '@angular/core';

export type TvIconName =
  | 'back'
  | 'home'
  | 'menu'
  | 'mute'
  | 'play-pause'
  | 'keyboard'
  | 'power'
  | 'touchpad'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'plus'
  | 'minus'
  | 'previous'
  | 'next'
  | 'input'
  | 'apps'
  | 'refresh'
  | 'rename'
  | 'close'
  | 'search'
  | 'clean'
  | 'clock';

// Traços simples (24x24, contorno) só do controle. Decorativos: o texto do botão é que informa.
const PATHS: Record<TvIconName, string> = {
  back: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  home: 'M3 11l9-8 9 8 M5 10v10h5v-6h4v6h5V10',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  mute: 'M4 9v6h4l5 4V5L8 9H4z M17 9l5 6 M22 9l-5 6',
  'play-pause': 'M4 5l8 7-8 7z M15 5v14 M20 5v14',
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  power: 'M12 3v9 M6.3 6.3a8 8 0 1 0 11.4 0',
  touchpad: 'M3 5h18v14H3z M8 15h8',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  previous: 'M7 5v14 M19 5l-9 7 9 7z',
  next: 'M17 5v14 M5 5l9 7-9 7z',
  input: 'M4 12h12 M12 7l5 5-5 5 M20 4v16',
  apps: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  rename: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  close: 'M6 6l12 12 M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-5-5',
  clean:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z',
  clock: 'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
};

@Component({
  selector: 'app-tv-icon',
  template: `
    <svg
      viewBox="0 0 24 24"
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
      width: 1.5em;
      height: 1.5em;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class TvIcon {
  readonly name = input.required<TvIconName>();

  protected path(): string {
    return PATHS[this.name()];
  }
}
