import { Component } from '@angular/core';
import { SecuritySection } from './security-section';
import { SessionsSection } from './sessions-section';

/** Segurança (só do administrador): as passkeys da conta. A rota tem o guarda de papel e a seção só carrega para o administrador. */
@Component({
  selector: 'app-security-page',
  imports: [SecuritySection, SessionsSection],
  template: `<app-sessions-section class="ui-rise" /><app-security-section class="ui-rise" />`,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }
  `,
})
export class SecurityPage {}
