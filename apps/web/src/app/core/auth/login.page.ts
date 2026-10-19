import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem } from './api-problem';
import { AuthService } from './auth.service';
import { safeNextUrl } from './next-url';

type LoginError =
  | { readonly kind: 'invalid' | 'bad-request' | 'network' | 'failed' }
  | { readonly kind: 'locked' | 'rate-limited'; readonly seconds: number | null };

/**
 * Tela de entrada. A mensagem de erro é a mesma para e-mail inexistente e senha errada (a API também não
 * distingue). Depois de entrar, volta para o `next` da URL só se for um caminho relativo da própria origem.
 */
@Component({
  selector: 'app-login-page',
  templateUrl: './login.page.html',
  styleUrl: './login.page.css',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  private readonly emailField = viewChild.required<ElementRef<HTMLInputElement>>('emailField');
  private readonly errorBox = viewChild<ElementRef<HTMLElement>>('errorBox');

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly showPassword = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<LoginError | null>(null);
  /** Segundos que faltam para poder tentar de novo (bloqueio da conta ou limite de tentativas). */
  protected readonly waitSeconds = signal(0);

  protected readonly blocked = computed(() => this.waitSeconds() > 0);
  protected readonly errorText = computed(() => {
    const error = this.error();
    if (!error) return null;
    switch (error.kind) {
      case 'invalid':
        return $localize`:@@auth.login.error.invalid:E-mail ou senha inválidos.`;
      case 'bad-request':
        return $localize`:@@auth.login.error.bad-request:Confira o e-mail e a senha digitados.`;
      case 'network':
        return $localize`:@@auth.login.error.network:Sem conexão com o servidor. Tente de novo.`;
      case 'locked':
        return $localize`:@@auth.login.error.locked:Conta bloqueada por um tempo, por causa de tentativas erradas.`;
      case 'rate-limited':
        return $localize`:@@auth.login.error.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
      default:
        return $localize`:@@auth.login.error.failed:Não foi possível entrar agora. Tente de novo.`;
    }
  });

  private countdown: ReturnType<typeof setInterval> | undefined;

  constructor() {
    afterNextRender(() => this.emailField().nativeElement.focus());
    inject(DestroyRef).onDestroy(() => clearInterval(this.countdown));
    // Quem já tem sessão (cookie válido) não precisa digitar nada.
    void this.auth.init().then(() => {
      if (this.auth.status() === 'authenticated') this.leave();
    });
  }

  protected setEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  protected setPassword(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
  }

  protected toggleShowPassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.blocked()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.email().trim(), this.password());
      this.password.set('');
      this.leave();
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
      this.error.set({
        kind: locked ? 'locked' : 'rate-limited',
        seconds: problem.retryAfterSeconds,
      });
      this.startCountdown(problem.retryAfterSeconds ?? 0);
    } else if (problem?.status === 401) {
      this.error.set({ kind: 'invalid' });
    } else if (problem?.status === 400) {
      this.error.set({ kind: 'bad-request' });
    } else if (problem?.isNetwork) {
      this.error.set({ kind: 'network' });
    } else {
      this.error.set({ kind: 'failed' });
    }
    // O erro é anunciado (role="alert") e recebe o foco, para quem usa leitor de tela ou teclado.
    afterNextRender(() => this.errorBox()?.nativeElement.focus(), { injector: this.injector });
  }

  private startCountdown(seconds: number): void {
    clearInterval(this.countdown);
    this.waitSeconds.set(Math.max(0, Math.ceil(seconds)));
    if (seconds <= 0) return;
    this.countdown = setInterval(() => {
      this.waitSeconds.update((left) => Math.max(0, left - 1));
      if (this.waitSeconds() === 0) clearInterval(this.countdown);
    }, 1_000);
  }

  private leave(): void {
    const next = safeNextUrl(
      this.route.snapshot.queryParamMap.get('next'),
      this.doc.defaultView?.location.origin ?? 'http://localhost',
    );
    void this.router.navigateByUrl(next ?? '/', { replaceUrl: true });
  }
}
