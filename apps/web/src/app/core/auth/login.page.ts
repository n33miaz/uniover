import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiProblem } from './api-problem';
import { AuthField } from './auth-field';
import { AuthLayout } from './auth-layout';
import { AuthBanner, AuthCountdown, AuthNotice, AuthTone } from './auth-notice';
import { AuthGlyphName } from './auth-glyph';
import { isPlausibleEmail } from './auth-validation';
import { QrLoginPanel } from './qr/qr-login-panel';
import { AuthService } from './auth.service';
import { createCountdown, describeWait, formatCountdown } from './countdown';
import { safeNextUrl } from './next-url';

type LoginError = 'invalid' | 'bad-request' | 'network' | 'failed' | 'locked' | 'rate-limited';

/**
 * Tela de entrada. A mensagem de erro é a mesma para e-mail inexistente e senha errada (a API também não
 * distingue). Depois de entrar, volta para o `next` da URL só se for um caminho relativo da própria origem.
 *
 * Validação gentil: o aviso de um campo só aparece depois de ele perder o foco ou de um envio, nunca a cada tecla,
 * e o botão nunca fica desabilitado por campo vazio (ele leva ao aviso). Só desabilita enquanto envia e durante a
 * espera de um bloqueio, que termina sozinha.
 */
@Component({
  selector: 'app-login-page',
  imports: [AuthLayout, AuthField, AuthNotice, QrLoginPanel, RouterLink],
  templateUrl: './login.page.html',
  styleUrl: './login.page.css',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  private readonly emailField = viewChild.required<AuthField>('emailField');
  private readonly passwordField = viewChild.required<AuthField>('passwordField');
  private readonly notice = viewChild(AuthNotice);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly emailTouched = signal(false);
  protected readonly passwordTouched = signal(false);
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<LoginError | null>(null);

  /** Espera de um bloqueio da conta ou do limite de tentativas. */
  private readonly wait = createCountdown();
  /** Quanto durou a espera que está correndo: dá a largura da barra e a frase para o leitor de tela. */
  protected readonly waitTotal = signal(0);
  protected readonly countdown = computed<AuthCountdown>(() => ({
    label: formatCountdown(this.wait.remaining()),
    words: describeWait(this.waitTotal()),
    total: this.waitTotal(),
  }));
  protected readonly blocked = computed(() => this.wait.remaining() > 0);

  protected readonly emailError = computed(() => {
    if (!this.emailTouched() && !this.submitted()) return null;
    const value = this.email().trim();
    if (value.length === 0) return $localize`:@@auth.login.email-required:Informe o seu e-mail.`;
    return isPlausibleEmail(value)
      ? null
      : $localize`:@@auth.login.email-format:Confira o e-mail: algo como nome@exemplo.com.`;
  });

  protected readonly passwordError = computed(() =>
    (this.passwordTouched() || this.submitted()) && this.password().length === 0
      ? $localize`:@@auth.login.password-required:Informe a sua senha.`
      : null,
  );

  protected readonly banner = computed<AuthBanner | null>(() => {
    const error = this.error();
    if (!error) return null;
    switch (error) {
      case 'invalid':
        return this.plain(
          'bad',
          'alert-circle',
          $localize`:@@auth.login.error.invalid:E-mail ou senha incorretos.`,
          $localize`:@@auth.login.error.invalid-detail:Confira os dados e tente de novo.`,
        );
      case 'bad-request':
        return this.plain(
          'bad',
          'alert-circle',
          $localize`:@@auth.login.error.bad-request:Confira o e-mail e a senha digitados.`,
        );
      case 'network':
        return this.plain(
          'warn',
          'wifi-off',
          $localize`:@@auth.login.error.network:Sem conexão com o servidor.`,
          $localize`:@@auth.login.error.network-detail:Verifique a sua internet e tente de novo.`,
        );
      case 'locked':
      case 'rate-limited':
        return this.waitBanner(error);
      default:
        return this.plain(
          'warn',
          'alert-circle',
          $localize`:@@auth.login.error.failed:Não foi possível entrar agora.`,
          $localize`:@@auth.login.error.failed-detail:Algo deu errado do nosso lado. Tente de novo em instantes.`,
        );
    }
  });

  private leaving = signal(false);
  protected readonly sending = computed(() => this.busy() || this.leaving());

  constructor() {
    // No computador o cursor já cai no e-mail. No celular não: focar sozinho abre o teclado e esconde a tela
    // antes de a pessoa ler qualquer coisa (e, para leitor de tela, pularia o título).
    afterNextRender(() => {
      const pointer = this.doc.defaultView?.matchMedia?.('(hover: hover) and (pointer: fine)');
      if (pointer?.matches) this.emailField().focus();
    });
    inject(DestroyRef).onDestroy(() => this.wait.stop());
    // Quem já tem sessão (cookie válido) não precisa digitar nada.
    void this.auth.init().then(() => {
      if (this.auth.status() === 'authenticated') void this.leave();
    });
  }

  /** O celular confirmou a entrada pelo QR e a sessão já está aberta: segue para o destino, como depois da senha. */
  protected onQrSignedIn(): void {
    void this.leave();
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.sending() || this.blocked()) return;
    this.submitted.set(true);
    this.error.set(null);
    // Campo inválido: o foco vai para o primeiro (a mensagem dele já está ligada ao campo).
    if (this.emailError()) return this.emailField().focus();
    if (this.passwordError()) return this.passwordField().focus();

    this.busy.set(true);
    try {
      await this.auth.login(this.email().trim(), this.password());
      this.password.set('');
      this.leaving.set(true);
      await this.leave();
      this.leaving.set(false);
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  private fail(error: unknown): void {
    const problem = error instanceof ApiProblem ? error : null;
    if (problem?.status === 429) {
      const locked = problem.kind === 'login-locked';
      this.error.set(locked ? 'locked' : 'rate-limited');
      this.waitTotal.set(Math.max(0, Math.ceil(problem.retryAfterSeconds ?? 0)));
      this.wait.start(this.waitTotal());
    } else if (problem?.status === 401) {
      this.error.set('invalid');
    } else if (problem?.status === 400) {
      this.error.set('bad-request');
    } else if (problem?.isNetwork) {
      this.error.set('network');
    } else {
      this.error.set('failed');
    }
    // O erro é anunciado (role="alert") e recebe o foco, para quem usa leitor de tela ou teclado.
    afterNextRender(() => this.notice()?.focus(), { injector: this.injector });
  }

  private plain(
    tone: AuthTone,
    icon: AuthGlyphName,
    heading: string,
    detail: string | null = null,
  ): AuthBanner {
    return { tone, role: 'alert', icon, heading, detail, waiting: false };
  }

  /**
   * Bloqueio da conta e limite de tentativas: enquanto a espera corre, a faixa avisa e conta; quando ela acaba, a
   * mesma faixa vira "pronto" sozinha. Sem tempo informado pelo servidor não há contagem nem "pronto".
   */
  private waitBanner(error: 'locked' | 'rate-limited'): AuthBanner {
    if (this.waitTotal() > 0 && !this.blocked()) {
      return {
        tone: 'ok',
        role: 'status',
        icon: 'check-circle',
        heading: $localize`:@@auth.login.wait-over:Pronto, você já pode tentar de novo.`,
        detail: null,
        waiting: false,
      };
    }
    const waiting = this.blocked();
    return error === 'locked'
      ? {
          tone: 'warn',
          role: 'alert',
          icon: 'lock',
          heading: $localize`:@@auth.login.error.locked:Conta bloqueada por um tempo.`,
          detail: $localize`:@@auth.login.error.locked-detail:Foram muitas tentativas erradas. Por segurança, espere um pouco antes de tentar de novo.`,
          waiting,
        }
      : {
          tone: 'warn',
          role: 'alert',
          icon: 'clock',
          heading: $localize`:@@auth.login.error.rate-limited:Muitas tentativas seguidas.`,
          detail: $localize`:@@auth.login.error.rate-limited-detail:Espere um pouco antes de tentar de novo.`,
          waiting,
        };
  }

  private leave(): Promise<boolean> {
    const next = safeNextUrl(
      this.route.snapshot.queryParamMap.get('next'),
      this.doc.defaultView?.location.origin ?? 'http://localhost',
    );
    return this.router.navigateByUrl(next ?? '/', { replaceUrl: true });
  }
}
