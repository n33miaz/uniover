import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { AuthField } from './auth-field';
import { AuthLayout } from './auth-layout';
import { MIN_PASSWORD_LENGTH } from './password-strength';

const RESET_SECRET = /^[A-Za-z0-9_-]{20,64}$/;

@Component({
  selector: 'app-reset-password-page',
  imports: [AuthLayout, AuthField, RouterLink],
  template: `
    <app-auth-layout [attr.data-screen-ready]="'auth-reset'">
      <h1 i18n="@@auth.reset.title">Escolher Nova Senha</h1>
      @if (!validLink()) {
        <p role="alert" i18n="@@auth.reset.invalid-link">Este link está incompleto ou venceu. Peça outro.</p>
        <p class="back"><a routerLink="/recuperar-senha" i18n="@@auth.reset.new-link">Pedir Outro Link</a></p>
      } @else if (done()) {
        <p role="status" i18n="@@auth.reset.done">Senha alterada. Entre com a nova senha.</p>
        <p class="back"><a routerLink="/entrar" i18n="@@auth.reset.login">Ir para Entrar</a></p>
      } @else {
        <form (submit)="submit($event)" novalidate>
          <app-auth-field [fieldId]="'reset-password'" [name]="'new-password'" label="Nova senha"
            i18n-label="@@auth.reset.password" [kind]="'password'" [autocomplete]="'new-password'"
            [enterKeyHint]="'next'" [error]="passwordIssue()" [(value)]="password" />
          <app-auth-field [fieldId]="'reset-confirmation'" [name]="'confirmation'" label="Repita a nova senha"
            i18n-label="@@auth.reset.confirmation" [kind]="'password'" [autocomplete]="'new-password'"
            [enterKeyHint]="'go'" [error]="confirmationIssue()" [(value)]="confirmation" />
          @if (factorRequired()) {
            <app-auth-field [fieldId]="'reset-factor'" [name]="'one-time-code'"
              label="Código do autenticador ou recuperação" i18n-label="@@auth.reset.factor"
              [kind]="'text'" [autocomplete]="'one-time-code'" [enterKeyHint]="'go'"
              [(value)]="factor" />
          }
          @if (error()) { <p role="alert">{{ error() }}</p> }
          <button class="ui-btn primary block" type="submit" [disabled]="busy()"
            i18n="@@auth.reset.submit">Salvar Nova Senha</button>
        </form>
        <p class="back"><a routerLink="/entrar" i18n="@@auth.reset.back">Voltar para Entrar</a></p>
      }
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
export class ResetPasswordPage {
  private readonly api = inject(AuthApi);
  private readonly doc = inject(DOCUMENT);
  #token: string | null = null;
  protected readonly validLink = signal(false);
  protected readonly password = signal('');
  protected readonly confirmation = signal('');
  protected readonly factor = signal('');
  protected readonly factorRequired = signal(false);
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly passwordIssue = computed(() =>
    this.submitted() && (this.password().length < MIN_PASSWORD_LENGTH || this.password().length > 256)
      ? $localize`:@@auth.reset.password-length:A senha precisa ter entre 10 e 256 caracteres.`
      : null,
  );
  protected readonly confirmationIssue = computed(() =>
    this.submitted() && this.confirmation() !== this.password()
      ? $localize`:@@auth.reset.password-mismatch:As senhas não coincidem.`
      : null,
  );

  constructor() {
    const win = this.doc.defaultView;
    const hash = win?.location.hash.replace(/^#/, '') ?? '';
    const token = new URLSearchParams(hash).get('token');
    if (token && RESET_SECRET.test(token)) {
      this.#token = token;
      this.validLink.set(true);
    }
    if (hash) win?.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.#token) return;
    this.submitted.set(true);
    this.error.set(null);
    if (this.passwordIssue() || this.confirmationIssue()) return;
    this.busy.set(true);
    try {
      await this.api.resetPassword(this.#token, this.password(), this.factor().trim() || undefined);
      this.#token = null;
      this.password.set('');
      this.confirmation.set('');
      this.factor.set('');
      this.done.set(true);
    } catch (caught) {
      const problem = caught instanceof ApiProblem ? caught : null;
      if (problem?.kind === 'second-factor-required') {
        this.factorRequired.set(true);
        this.error.set($localize`:@@auth.reset.factor-required:Informe o código do autenticador ou um código de recuperação.`);
      } else if (problem?.status === 403) {
        this.error.set($localize`:@@auth.reset.factor-invalid:Código inválido. Confira e tente novamente.`);
      } else if (problem?.status === 400) {
        this.#token = null;
        this.validLink.set(false);
      } else {
        this.error.set($localize`:@@auth.reset.failed:Não foi possível alterar a senha agora. Tente novamente.`);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
