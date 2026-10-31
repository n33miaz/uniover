import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiProblem, isStepUpRequired, problemOf } from '../api-problem';
import { AuthApi, QrLoginInfo } from '../auth-api';
import { AuthField } from '../auth-field';
import { AuthGlyph } from '../auth-glyph';
import { AuthLayout } from '../auth-layout';
import { AuthService } from '../auth.service';
import { deviceLabel } from './device-label';
import { QrApproveSkeleton } from './qr-approve-skeleton';

type View = 'loading' | 'ready' | 'invalid' | 'approved' | 'denied' | 'error';
type Problem = 'wrong-password' | 'locked' | 'network' | 'failed';

/**
 * Tela do CELULAR (já com sessão) aberta pelo link do QR que um computador mostra: diz o que se sabe do computador e pede
 * a confirmação. Quem confirma entrega ao computador uma sessão inteira da conta, então o texto avisa para só confirmar
 * se foi a própria pessoa que abriu o QR, e a prova que a API pede (passkey ou senha) vem aqui, no celular, nunca no
 * computador. O código vem do `?codigo=`.
 */
@Component({
  selector: 'app-qr-approve-page',
  imports: [AuthLayout, AuthField, AuthGlyph, QrApproveSkeleton, RouterLink],
  templateUrl: './qr-approve.page.html',
  styleUrl: './qr-approve.page.css',
})
export class QrApprovePage {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);

  private readonly passwordField = viewChild(AuthField);

  private readonly code = this.route.snapshot.queryParamMap.get('codigo') ?? '';

  protected readonly view = signal<View>('loading');
  protected readonly info = signal<QrLoginInfo | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal<Problem | null>(null);
  protected readonly password = signal('');
  protected readonly passwordTouched = signal(false);

  protected readonly device = computed(
    () =>
      deviceLabel(this.info()?.userAgent) ??
      $localize`:@@auth.qr.device-unknown:Computador desconhecido`,
  );
  protected readonly needsPassword = computed(() => this.info()?.verification === 'password');
  protected readonly passwordError = computed(() => {
    if (this.problem() === 'wrong-password') {
      return $localize`:@@auth.qr.password-wrong:Senha incorreta.`;
    }
    return this.passwordTouched() && this.password().length === 0
      ? $localize`:@@auth.qr.password-required:Informe a sua senha.`
      : null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.code) {
      this.view.set('invalid');
      return;
    }
    try {
      this.info.set(
        await this.auth.authorized((token) => this.api.qrInfo(token, this.code), {
          stepUp: false,
        }),
      );
      this.view.set('ready');
    } catch (error) {
      this.view.set(this.isInvalid(error) ? 'invalid' : 'error');
    }
  }

  protected async confirm(): Promise<void> {
    if (this.busy()) return;
    this.problem.set(null);
    if (this.needsPassword() && this.password().length === 0) {
      this.passwordTouched.set(true);
      this.passwordField()?.focus();
      return;
    }
    this.busy.set(true);
    try {
      // Com passkey a API responde "confirmação necessária": o `authorized` abre o diálogo e repete o pedido.
      const password = this.needsPassword() ? this.password() : null;
      await this.auth.authorized((token) => this.api.qrApprove(token, this.code, password));
      this.password.set('');
      this.view.set('approved');
    } catch (error) {
      await this.failConfirm(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async deny(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.authorized((token) => this.api.qrDeny(token, this.code), { stepUp: false });
      this.view.set('denied');
    } catch (error) {
      if (this.isInvalid(error)) this.view.set('invalid');
      else this.problem.set(problemOf(error)?.isNetwork ? 'network' : 'failed');
    } finally {
      this.busy.set(false);
    }
  }

  private async failConfirm(error: unknown): Promise<void> {
    const problem = error instanceof ApiProblem ? error : problemOf(error);
    if (!problem) return void this.problem.set('failed');
    if (this.isInvalid(problem)) return void this.view.set('invalid');
    if (problem.isNetwork) return void this.problem.set('network');
    // Passkey cancelada ou recusada no diálogo: a pessoa só decidiu não confirmar, o botão segue ali.
    if (isStepUpRequired(problem)) return;
    if (problem.kind === 'invalid-password') {
      this.problem.set('wrong-password');
      this.password.set('');
      afterNextRender(() => this.passwordField()?.focus(), { injector: this.injector });
      return;
    }
    if (problem.kind === 'qr-reauth-required') {
      // A sessão envelheceu entre abrir a tela e confirmar: relê o que é preciso (agora a senha).
      await this.load();
      return;
    }
    this.problem.set(problem.status === 429 ? 'locked' : 'failed');
  }

  private isInvalid(error: unknown): boolean {
    const problem = problemOf(error);
    return problem?.status === 410 || problem?.status === 400;
  }
}
