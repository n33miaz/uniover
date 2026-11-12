import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { ApiProblem, problemOf } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';

/** Troca voluntária da senha da própria conta, sem encerrar a sessão em uso. */
@Component({
  selector: 'app-password-section',
  templateUrl: './password-section.html',
  styleUrl: './password-section.css',
})
export class PasswordSection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly form = viewChild<ElementRef<HTMLFormElement>>('passwordForm');

  protected readonly currentPassword = signal('');
  protected readonly newPassword = signal('');
  protected readonly confirmation = signal('');
  protected readonly busy = signal(false);
  protected readonly submitted = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly saved = signal(false);

  protected readonly newPasswordIssue = computed(() => {
    const value = this.newPassword();
    if (value.length < 10)
      return $localize`:@@settings.password.minimum:A nova senha precisa ter pelo menos 10 caracteres.`;
    if (value.length > 256)
      return $localize`:@@settings.password.maximum:A nova senha pode ter no máximo 256 caracteres.`;
    if (value === this.currentPassword())
      return $localize`:@@settings.password.different:Escolha uma senha diferente da atual.`;
    return null;
  });

  protected readonly confirmationIssue = computed(() =>
    this.confirmation() !== this.newPassword()
      ? $localize`:@@settings.password.mismatch:As novas senhas não coincidem.`
      : null,
  );

  protected edit(field: 'current' | 'new' | 'confirmation', value: string): void {
    if (field === 'current') this.currentPassword.set(value);
    if (field === 'new') this.newPassword.set(value);
    if (field === 'confirmation') this.confirmation.set(value);
    this.message.set(null);
    this.saved.set(false);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.submitted.set(true);
    this.message.set(null);
    this.saved.set(false);
    if (!this.currentPassword() || this.newPasswordIssue() || this.confirmationIssue()) return;

    this.busy.set(true);
    try {
      await this.auth.authorized(
        (token) => this.api.changePassword(token, this.currentPassword(), this.newPassword()),
        { stepUp: false },
      );
      this.currentPassword.set('');
      this.newPassword.set('');
      this.confirmation.set('');
      this.form()?.nativeElement.reset();
      this.submitted.set(false);
      this.saved.set(true);
    } catch (error) {
      this.message.set(this.failureMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  private failureMessage(error: unknown): string {
    const problem = problemOf(error);
    if (problem instanceof ApiProblem) {
      if (problem.kind === 'invalid-password')
        return $localize`:@@settings.password.invalid-current:A senha atual está incorreta.`;
      if (problem.kind === 'login-locked' || problem.status === 429)
        return $localize`:@@settings.password.locked:Muitas tentativas. Aguarde um pouco antes de tentar novamente.`;
      if (problem.status === 400)
        return $localize`:@@settings.password.invalid-new:Confira a nova senha e tente novamente.`;
      if (problem.isNetwork)
        return $localize`:@@settings.password.network:Sem conexão. Tente novamente.`;
    }
    return $localize`:@@settings.password.failed:Não foi possível trocar a senha agora.`;
  }
}
