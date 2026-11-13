import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthApi } from './auth-api';
import { AuthField } from './auth-field';
import { AuthLayout } from './auth-layout';
import { isPlausibleEmail } from './auth-validation';

/** A resposta nunca confirma se o endereço pertence a uma conta. */
@Component({
  selector: 'app-request-recovery-page',
  imports: [AuthLayout, AuthField, RouterLink],
  template: `
    <app-auth-layout [attr.data-screen-ready]="'auth-recovery'">
      <h1 i18n="@@auth.recovery.title">Recuperar senha</h1>
      @if (sent()) {
        <p role="status" i18n="@@auth.recovery.sent">Se este e-mail estiver cadastrado, enviaremos um link para escolher outra senha. Confira também o spam.</p>
      } @else if (available() === null) {
        <p role="status" i18n="@@auth.recovery.checking">Verificando a recuperação por e-mail…</p>
      } @else if (!available()) {
        <p role="status" i18n="@@auth.recovery.unavailable">A recuperação por e-mail ainda não está disponível. Se você já entrou em outro aparelho, pode alterar sua senha nos ajustes da conta.</p>
      } @else {
        <p i18n="@@auth.recovery.explain">Informe o e-mail da sua conta.</p>
        <form (submit)="submit($event)" novalidate>
          <app-auth-field [fieldId]="'recovery-email'" [name]="'email'" label="E-mail"
            i18n-label="@@auth.recovery.email" [kind]="'email'" [autocomplete]="'username'"
            [enterKeyHint]="'go'" [error]="emailIssue()" [(value)]="email" />
          @if (error()) { <p role="alert">{{ error() }}</p> }
          <button class="ui-btn primary block" type="submit" [disabled]="busy()"
            i18n="@@auth.recovery.send">Enviar link</button>
        </form>
      }
      <p class="back"><a routerLink="/entrar" i18n="@@auth.recovery.back">Voltar para Entrar</a></p>
    </app-auth-layout>
  `,
  styles: `
    h1 {
      margin-bottom: var(--space-5);
      font-size: var(--auth-title);
      font-weight: 750;
      letter-spacing: -0.02em;
      text-align: center;
      text-wrap: balance;
    }
    form { display: flex; flex-direction: column; gap: var(--space-4); }
    p { line-height: 1.5; }
    .back { text-align: center; margin-top: var(--space-4); }
    button { min-height: 48px; }
  `,
})
export class RequestRecoveryPage {
  private readonly api = inject(AuthApi);
  protected readonly email = signal('');
  protected readonly submitted = signal(false);
  protected readonly sent = signal(false);
  protected readonly available = signal<boolean | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly emailIssue = computed(() =>
    this.submitted() && !isPlausibleEmail(this.email().trim())
      ? $localize`:@@auth.recovery.invalid-email:Informe um e-mail válido.`
      : null,
  );

  constructor() {
    void this.api.passwordRecoveryAvailability()
      .then((status) => this.available.set(status.enabled))
      .catch(() => this.available.set(false));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.available()) return;
    this.submitted.set(true);
    this.error.set(null);
    if (this.emailIssue()) return;
    this.busy.set(true);
    try {
      await this.api.requestPasswordRecovery(this.email().trim());
      this.sent.set(true);
    } catch {
      this.error.set($localize`:@@auth.recovery.failed:Não foi possível enviar o pedido agora. Tente novamente.`);
    } finally {
      this.busy.set(false);
    }
  }
}
