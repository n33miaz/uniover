import { Component } from '@angular/core';
import { SecuritySection } from './security-section';

/** Segurança (só do administrador): as passkeys da conta. A rota tem o guarda de papel e a seção só carrega para o administrador. */
@Component({
  selector: 'app-security-page',
  imports: [SecuritySection],
  template: `<app-security-section class="ui-rise" />`,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }
  `,
})
export class SecurityPage {}
