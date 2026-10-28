import { Component } from '@angular/core';
import { SecuritySection } from './security-section';
import { SessionsSection } from './sessions-section';

/** Segurança pessoal: passkeys e Sessões de Acesso da conta atual. */
@Component({
  selector: 'app-security-page',
  imports: [SecuritySection, SessionsSection],
  template: `
    <p class="intro ui-rise" i18n="@@settings.security.intro">
      Passkeys e sessões ajudam a proteger sua conta.
    </p>
    <app-sessions-section class="ui-rise" />
    <app-security-section class="ui-rise" />
  `,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }

    .intro {
      margin: 0 0 var(--space-3);
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
  `,
})
export class SecurityPage {}
