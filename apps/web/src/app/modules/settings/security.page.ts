import { Component, computed, inject } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { SecuritySection } from './security-section';
import { SessionsSection } from './sessions-section';

/**
 * Segurança pessoal. O dono vê as passkeys e as Sessões de Acesso da conta; o convidado vê só as próprias sessões (as
 * passkeys são rota de dono, então a tela nem as menciona para ele).
 */
@Component({
  selector: 'app-security-page',
  imports: [SecuritySection, SessionsSection],
  template: `
    @if (isOwner()) {
      <p class="intro ui-rise" i18n="@@settings.security.intro">
        Passkeys e sessões ajudam a proteger sua conta.
      </p>
    } @else {
      <p class="intro ui-rise" i18n="@@settings.security.guest-intro">
        Veja onde sua conta está aberta e encerre o que você não reconhece.
      </p>
    }
    <app-sessions-section class="ui-rise" />
    @if (isOwner()) {
      <app-security-section class="ui-rise" />
    }
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
export class SecurityPage {
  private readonly session = inject(SessionState);

  protected readonly isOwner = computed(() => this.session.role() === 'owner');
}
