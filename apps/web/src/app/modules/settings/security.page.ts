import { Component, computed, inject } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { PasswordSection } from './password-section';
import { SecuritySection } from './security-section';
import { SessionsSection } from './sessions-section';
import { TotpSection } from './totp-section';
import { RecoveryCodeSection } from './recovery-code-section';

/**
 * Segurança pessoal. Toda conta pode trocar a senha e cuidar das próprias sessões; o dono também gerencia passkeys.
 */
@Component({
  selector: 'app-security-page',
  imports: [PasswordSection, SecuritySection, SessionsSection, TotpSection, RecoveryCodeSection],
  template: `
    <app-password-section class="ui-rise" />
    <app-recovery-code-section class="ui-rise" />
    <app-totp-section class="ui-rise" />
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
