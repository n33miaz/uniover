import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiProblem } from './api-problem';
import { AuthService } from './auth.service';

/** Mesmo tamanho mínimo da senha do dono (a API é quem decide; isto só poupa uma ida ao servidor). */
export const MIN_PASSWORD_LENGTH = 10;

/** O segredo do convite é base64url de 32 bytes (43 caracteres); qualquer coisa fora disso nem é enviada. */
const INVITE_SECRET = /^[A-Za-z0-9_-]{20,64}$/;

type InviteError =
  | 'too-short'
  | 'mismatch'
  | 'bad-request'
  | 'gone'
  | 'email-taken'
  | 'rate-limited'
  | 'network'
  | 'failed';

/**
 * Tela de aceite do convite do dono. O link traz o segredo no fragmento (`/convite#...`), que o navegador nunca
 * envia ao servidor nem a outro site; a tela o guarda só em memória, tira o fragmento do endereço e o manda no
 * corpo do pedido. A pessoa escolhe o próprio e-mail e a própria senha (o dono nunca a conhece) e, ao terminar, já
 * está dentro: o convidado cai direto no controle da TV. Não existe recuperação de senha, e a tela avisa.
 */
@Component({
  selector: 'app-accept-invite-page',
  imports: [RouterLink],
  templateUrl: './accept-invite.page.html',
  styleUrl: './accept-invite.page.css',
})
export class AcceptInvitePage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);

  private readonly emailField = viewChild<ElementRef<HTMLInputElement>>('emailField');
  private readonly errorBox = viewChild<ElementRef<HTMLElement>>('errorBox');

  /** Só em memória: nunca em signal, em armazenamento ou na tela. */
  readonly #secret: string | null;

  protected readonly hasInvite: boolean;
  protected readonly minLength = MIN_PASSWORD_LENGTH;

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly confirmation = signal('');
  protected readonly showPassword = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<InviteError | null>(null);
  protected readonly waitSeconds = signal<number | null>(null);

  protected readonly errorText = computed(() => {
    switch (this.error()) {
      case null:
        return null;
      case 'too-short':
        return $localize`:@@auth.invite.error.too-short:A senha precisa ter ao menos ${MIN_PASSWORD_LENGTH}:min: caracteres.`;
      case 'mismatch':
        return $localize`:@@auth.invite.error.mismatch:As duas senhas não são iguais.`;
      case 'bad-request':
        return $localize`:@@auth.invite.error.bad-request:Confira o e-mail e a senha digitados.`;
      case 'gone':
        return $localize`:@@auth.invite.error.gone:Este convite não vale mais. Peça um novo a quem o enviou.`;
      case 'email-taken':
        return $localize`:@@auth.invite.error.email-taken:Este e-mail não pode ser usado. Escolha outro.`;
      case 'rate-limited':
        return $localize`:@@auth.invite.error.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
      case 'network':
        return $localize`:@@auth.invite.error.network:Sem conexão com o servidor. Tente de novo.`;
      default:
        return $localize`:@@auth.invite.error.failed:Não foi possível criar a conta agora. Tente de novo.`;
    }
  });

  constructor() {
    const fragment = this.route.snapshot.fragment;
    this.#secret = fragment && INVITE_SECRET.test(fragment) ? fragment : null;
    this.hasInvite = this.#secret !== null;

    // O segredo sai do endereço (e do histórico) assim que é lido.
    if (fragment) {
      void this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
    }
    afterNextRender(() => this.emailField()?.nativeElement.focus());
  }

  protected setEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  protected setPassword(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
  }

  protected setConfirmation(event: Event): void {
    this.confirmation.set((event.target as HTMLInputElement).value);
  }

  protected toggleShowPassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const secret = this.#secret;
    if (this.busy() || secret === null) return;

    if (this.password().length < MIN_PASSWORD_LENGTH) return this.fail('too-short');
    if (this.password() !== this.confirmation()) return this.fail('mismatch');

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.acceptInvite(secret, this.email().trim(), this.password());
      this.password.set('');
      this.confirmation.set('');
      // O convidado sai do início direto para a TV (o guarda de papel cuida disso).
      void this.router.navigateByUrl('/', { replaceUrl: true });
    } catch (error) {
      this.fail(this.kindOf(error));
    } finally {
      this.busy.set(false);
    }
  }

  private kindOf(error: unknown): InviteError {
    const problem = error instanceof ApiProblem ? error : null;
    if (problem?.status === 410) return 'gone';
    if (problem?.status === 409) return 'email-taken';
    if (problem?.status === 400) return 'bad-request';
    if (problem?.status === 429) {
      this.waitSeconds.set(problem.retryAfterSeconds);
      return 'rate-limited';
    }
    return problem?.isNetwork ? 'network' : 'failed';
  }

  private fail(kind: InviteError): void {
    this.error.set(kind);
    // O erro é anunciado (role="alert") e recebe o foco, para quem usa leitor de tela ou teclado.
    afterNextRender(() => this.errorBox()?.nativeElement.focus(), { injector: this.injector });
  }
}
