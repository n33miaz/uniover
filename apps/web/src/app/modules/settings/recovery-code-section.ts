import { Component, inject, signal } from '@angular/core';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';

/** Alternativa para quem ainda tem sessão, mas perdeu a senha. */
@Component({
  selector: 'app-recovery-code-section',
  template: `
    <details class="ui-card">
      <summary i18n="@@settings.recovery-code.title">Esqueci a senha e tenho um código de recuperação</summary>
      <p i18n="@@settings.recovery-code.explain">Use um dos códigos guardados ao ativar o autenticador. Todas as sessões serão encerradas.</p>
      <form (submit)="submit($event)" novalidate>
        <label for="recovery-code" i18n="@@settings.recovery-code.code">Código de recuperação</label>
        <input id="recovery-code" class="ui-input" autocomplete="off" [value]="code()"
          (input)="code.set(value($event))" />
        <label for="recovery-new-password" i18n="@@settings.recovery-code.new-password">Nova senha</label>
        <input id="recovery-new-password" class="ui-input" type="password" autocomplete="new-password"
          [value]="password()" (input)="password.set(value($event))" />
        <label for="recovery-confirmation" i18n="@@settings.recovery-code.confirmation">Repita a nova senha</label>
        <input id="recovery-confirmation" class="ui-input" type="password" autocomplete="new-password"
          [value]="confirmation()" (input)="confirmation.set(value($event))" />
        @if (message()) { <p role="alert">{{ message() }}</p> }
        <button type="submit" class="ui-btn primary" [disabled]="busy()"
          i18n="@@settings.recovery-code.submit">Redefinir senha</button>
      </form>
    </details>
  `,
  styles: `
    details { padding: var(--space-5); margin-block: var(--space-5); }
    summary { cursor: pointer; font-weight: 650; }
    form { display: flex; flex-direction: column; gap: var(--space-3); }
    p { line-height: 1.5; }
    input, button { min-height: 44px; }
  `,
})
export class RecoveryCodeSection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  protected readonly code = signal('');
  protected readonly password = signal('');
  protected readonly confirmation = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected value(event: Event): string { return (event.target as HTMLInputElement).value; }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    if (!this.code().trim() || this.password().length < 10 || this.password().length > 256 ||
      this.password() !== this.confirmation()) {
      this.message.set($localize`:@@settings.recovery-code.invalid:Confira o código e as duas senhas. A nova senha precisa ter ao menos 10 caracteres.`);
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.auth.authorized((token) =>
        this.api.recoverPasswordWithCode(token, this.code().trim(), this.password()));
      this.code.set('');
      this.password.set('');
      this.confirmation.set('');
      await this.auth.logout();
    } catch {
      this.message.set($localize`:@@settings.recovery-code.failed:Não foi possível usar o código. Confira e tente novamente.`);
    } finally {
      this.busy.set(false);
    }
  }
}
