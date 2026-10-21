import { Component } from '@angular/core';
import { SystemTvSection } from './system-tv-section';

/**
 * Sistema (só do administrador): a configuração do app feita aqui, sem mexer em variáveis do servidor. Cada módulo que
 * tiver o que configurar traz a sua seção; por ora só a da TV (qual computador a controla). A rota tem o guarda de papel e
 * a seção só carrega para o administrador.
 */
@Component({
  selector: 'app-system-page',
  imports: [SystemTvSection],
  template: `<app-system-tv-section class="ui-rise" />`,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }
  `,
})
export class SystemPage {}
