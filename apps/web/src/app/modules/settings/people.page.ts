import { Component } from '@angular/core';
import { GuestsSection } from './guests-section';

/** Pessoas (só do administrador): os convites e quem já entrou. A rota tem o guarda de papel e a seção só carrega para o administrador. */
@Component({
  selector: 'app-people-page',
  imports: [GuestsSection],
  template: `<app-guests-section class="ui-rise" />`,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }
  `,
})
export class PeoplePage {}
