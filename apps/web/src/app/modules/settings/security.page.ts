import { Component } from '@angular/core';
import { SecuritySection } from './security-section';
import { SessionsSection } from './sessions-section';

/** Segurança pessoal: passkeys e Sessões de Acesso da conta atual. */
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
