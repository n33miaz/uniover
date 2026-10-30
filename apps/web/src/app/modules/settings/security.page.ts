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
  `,
})
export class SecurityPage {
  private readonly session = inject(SessionState);

  protected readonly isOwner = computed(() => this.session.role() === 'owner');
}
