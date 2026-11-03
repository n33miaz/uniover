import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { QrCode } from '../../core/auth/qr/qr-code';
import { SessionState } from '../../core/session/session-state';

/** O segredo e os códigos ficam apenas nesta tela; a API mostra cada um uma única vez. */
@Component({
  selector: 'app-totp-section',
  imports: [QrCode],
  template: `
    <section aria-labelledby="totp-title">
      <h2 id="totp-title" i18n="@@settings.totp.title">Aplicativo autenticador</h2>
      <p i18n="@@settings.totp.explain">Use um código do aplicativo ao entrar. Guarde os códigos de recuperação em lugar seguro.</p>
      @if (recoveryCodes().length) {
        <p role="status" i18n="@@settings.totp.active">Autenticador ativado. Estes códigos aparecem somente agora.</p>
        <ul aria-label="Códigos de recuperação" i18n-aria-label="@@settings.totp.codes-label">
          @for (code of recoveryCodes(); track code) { <li><code>{{ code }}</code></li> }
        </ul>
        <button type="button" class="ui-btn secondary" (click)="closeCodes()"
          i18n="@@settings.totp.saved">Já guardei os códigos</button>
      } @else if (active()) {
        <p role="status" i18n="@@settings.totp.already-active">O autenticador já está ativo nesta conta. Restam {{ remaining() }} códigos de recuperação.</p>
      } @else if (loading()) {
        <p role="status" i18n="@@settings.totp.loading">Verificando o autenticador…</p>
      } @else if (!available()) {
        <p role="status" i18n="@@settings.totp.unavailable">O aplicativo autenticador ainda não está disponível nesta instalação.</p>
      } @else if (provisioningUri()) {
        <p i18n="@@settings.totp.scan">Leia o QR no aplicativo autenticador e informe o código de seis dígitos.</p>
        <app-qr-code [value]="provisioningUri()!" label="QR do aplicativo autenticador"
          i18n-label="@@settings.totp.qr-label" />
        <form (submit)="confirm($event)">
          <label for="totp-code" i18n="@@settings.totp.code">Código do aplicativo</label>
          <input id="totp-code" name="one-time-code" autocomplete="one-time-code" [attr.inputmode]="'numeric'"
            maxlength="6" [value]="code()" (input)="code.set(value($event))" />
          <button type="submit" class="ui-btn primary" [disabled]="busy()"
            i18n="@@settings.totp.confirm">Ativar</button>
        </form>
      } @else {
        <form (submit)="start($event)">
          <label for="totp-password" i18n="@@settings.totp.password">Senha atual</label>
          <input id="totp-password" type="password" name="password" autocomplete="current-password"
            [value]="password()" (input)="password.set(value($event))" />
          <button type="submit" class="ui-btn primary" [disabled]="busy()"
            i18n="@@settings.totp.start">Cadastrar autenticador</button>
        </form>
      }
      @if (message()) { <p role="alert">{{ message() }}</p> }
    </section>
  `,
  styles: `
    section { margin-block: var(--space-5); padding: var(--space-5); border: 1px solid var(--a-line); border-radius: var(--radius-lg); }
    h2 { margin: 0 0 var(--space-3); font-size: var(--fs-title); }
    p { line-height: 1.5; }
    form { display: flex; flex-direction: column; gap: var(--space-3); }
    input { min-height: 44px; padding: var(--space-3); border: 1px solid var(--a-line); border-radius: var(--radius-lg); background: var(--a-surface); color: var(--a-ink); }
    app-qr-code { display: block; width: min(100%, 15rem); margin: var(--space-4) auto; }
    ul { columns: 2; padding-inline-start: var(--space-5); }
    li { break-inside: avoid; margin-block: var(--space-2); }
    code { user-select: all; overflow-wrap: anywhere; }
    button { min-height: 44px; }
  `,
})
export class TotpSection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  protected readonly password = signal('');
  protected readonly code = signal('');
  protected readonly provisioningUri = signal<string | null>(null);
  protected readonly recoveryCodes = signal<readonly string[]>([]);
  protected readonly active = signal(false);
  protected readonly available = signal(false);
  protected readonly remaining = signal(0);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.session.status() === 'authenticated') untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    try {
      const status = await this.auth.authorized((token) => this.api.totpStatus(token));
      this.active.set(status.active);
      this.available.set(status.available);
      this.remaining.set(Number(status.recoveryCodesRemaining));
    } catch {
      this.message.set($localize`:@@settings.totp.status-failed:Não foi possível verificar o autenticador agora.`);
    } finally {
      this.loading.set(false);
    }
  }

  protected value(event: Event): string { return (event.target as HTMLInputElement).value; }

  protected async start(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.password()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const enrollment = await this.auth.authorized((token) => this.api.startTotp(token, this.password()));
      this.provisioningUri.set(enrollment.provisioningUri);
      this.password.set('');
    } catch (caught) {
      const problem = caught instanceof ApiProblem ? caught : null;
      if (problem?.status === 409) this.active.set(true);
      else this.message.set(problem?.kind === 'invalid-password'
        ? $localize`:@@settings.totp.invalid-password:Senha incorreta.`
        : $localize`:@@settings.totp.start-failed:Não foi possível iniciar o cadastro agora.`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !/^\d{6}$/.test(this.code())) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const result = await this.auth.authorized((token) => this.api.confirmTotp(token, this.code()));
      this.recoveryCodes.set(result.recoveryCodes);
      this.provisioningUri.set(null);
      this.code.set('');
      this.active.set(true);
      this.remaining.set(result.recoveryCodes.length);
    } catch {
      this.message.set($localize`:@@settings.totp.invalid-code:Código inválido ou cadastro vencido. Tente novamente.`);
    } finally {
      this.busy.set(false);
    }
  }

  protected closeCodes(): void { this.recoveryCodes.set([]); }
}
