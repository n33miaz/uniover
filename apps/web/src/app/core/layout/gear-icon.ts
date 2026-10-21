import { Component } from '@angular/core';

/** Contorno da engrenagem (oito dentes) e o miolo, na grade de 24: só caminhos, o desenho vem de dados. */
const GEAR_PATHS = [
  'M10.52 4.75L10.83 2.47A9.6 9.6 0 0 1 13.17 2.47L13.48 4.75A7.4 7.4 0 0 1 16.08 5.83L17.91 4.44A9.6 9.6 0 0 1 19.56 6.09L18.17 7.92A7.4 7.4 0 0 1 19.25 10.52L21.53 10.83A9.6 9.6 0 0 1 21.53 13.17L19.25 13.48A7.4 7.4 0 0 1 18.17 16.08L19.56 17.91A9.6 9.6 0 0 1 17.91 19.56L16.08 18.17A7.4 7.4 0 0 1 13.48 19.25L13.17 21.53A9.6 9.6 0 0 1 10.83 21.53L10.52 19.25A7.4 7.4 0 0 1 7.92 18.17L6.09 19.56A9.6 9.6 0 0 1 4.44 17.91L5.83 16.08A7.4 7.4 0 0 1 4.75 13.48L2.47 13.17A9.6 9.6 0 0 1 2.47 10.83L4.75 10.52A7.4 7.4 0 0 1 5.83 7.92L4.44 6.09A9.6 9.6 0 0 1 6.09 4.44L7.92 5.83A7.4 7.4 0 0 1 10.52 4.75Z',
  'M12 9.1a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z',
] as const;

/**
 * Engrenagem de configurações do sistema: o mesmo traço (2,2, pontas redondas) e o mesmo tamanho da seta de voltar, para o
 * botão redondo ocupar o lugar dela no cabeçalho. Decorativa (o nome acessível está no botão que a contém) e na cor do
 * texto do botão.
 */
@Component({
  selector: 'app-gear-icon',
  template: `
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (d of paths; track d) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
  `,
})
export class GearIcon {
  protected readonly paths = GEAR_PATHS;
}
