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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { skip } from 'rxjs';
import { ApiProblem } from './api-problem';
import { AuthField } from './auth-field';
import { AuthGlyph, AuthGlyphName } from './auth-glyph';
import { AuthLayout } from './auth-layout';
import { AuthBanner, AuthCountdown, AuthNotice } from './auth-notice';
import { AuthState } from './auth-state';
import { isPlausibleEmail } from './auth-validation';
import { AuthService } from './auth.service';
import { createCountdown, describeWait, formatCountdown } from './countdown';
import { MIN_PASSWORD_LENGTH, checkPassword } from './password-strength';

/** O segredo do convite é base64url de 32 bytes (43 caracteres); qualquer coisa fora disso nem é enviada. */
const INVITE_SECRET = /^[A-Za-z0-9_-]{20,64}$/;

/** Quanto o "tudo pronto" fica na tela antes de seguir sozinho (o botão "Continuar" segue na hora). */
export const WELCOME_MS = 1_200;

/** Silêncio depois da última tecla para o leitor de tela falar do estado da senha: sem isto ele narraria cada letra. */
const ANNOUNCE_DELAY_MS = 900;

type InviteView = 'form' | 'missing' | 'incomplete' | 'gone' | 'welcome';
type InviteError = 'too-short' | 'mismatch' | 'bad-request' | 'rate-limited' | 'network' | 'failed';
type Rule = 'pending' | 'met' | 'invalid';

/** O que o leitor de tela já ouviu sobre a senha: só se anuncia o que mudou desde então. */
interface PasswordAnnouncement {
  readonly met: boolean;
  readonly level: number;
  readonly match: boolean;
}

/**
 * Tela de aceite do convite do dono. O link traz o segredo no fragmento (`/convite#...`), que o navegador nunca
 * envia ao servidor nem a outro site; a tela o guarda só em memória, tira o fragmento do endereço e o manda no
 * corpo do pedido. A pessoa escolhe o próprio e-mail e a própria senha (o dono nunca a conhece) e, ao terminar, já
 * está dentro. Não existe recuperação de senha, e a tela avisa.
 *
 * A tela tem cinco estados: o formulário; o endereço sem convite (`missing`) ou com convite fora do padrão
 * (`incomplete`); o convite que a API não aceita mais (`gone`); e o "tudo pronto" (`welcome`), que segue sozinho.
 */
@Component({
  selector: 'app-accept-invite-page',
  imports: [RouterLink, AuthLayout, AuthField, AuthGlyph, AuthNotice, AuthState],
  templateUrl: './accept-invite.page.html',
  styleUrl: './accept-invite.page.css',
})
export class AcceptInvitePage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);

  private readonly emailField = viewChild<AuthField>('emailField');
  private readonly passwordField = viewChild<AuthField>('passwordField');
  private readonly confirmationField = viewChild<AuthField>('confirmationField');
  private readonly notice = viewChild(AuthNotice);
  private readonly stateBox = viewChild(AuthState);

  /** Só em memória: nunca em signal, em armazenamento ou na tela. */
  #secret: string | null = null;

  protected readonly view = signal<InviteView>('form');
  protected readonly minLength = MIN_PASSWORD_LENGTH;

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly confirmation = signal('');
  protected readonly emailTouched = signal(false);
  protected readonly confirmationTouched = signal(false);
  /** Já tentou enviar: a partir daí os avisos de campo aparecem sem esperar o foco sair. */
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<InviteError | null>(null);
  /** A API recusou o e-mail (409): o aviso fica no campo até a pessoa editá-lo. */
  protected readonly emailTaken = signal(false);
  /** O que o leitor de tela ouve sobre a senha (região cortês, atualizada só quando a digitação para). */
  protected readonly announcement = signal('');

  private readonly wait = createCountdown();
  private readonly waitTotal = signal(0);
  protected readonly blocked = computed(() => this.wait.remaining() > 0);
  protected readonly countdown = computed<AuthCountdown>(() => ({
    label: formatCountdown(this.wait.remaining()),
    words: describeWait(this.waitTotal()),
    total: this.waitTotal(),
  }));

  protected readonly check = computed(() => checkPassword(this.password()));
  protected readonly strengthLabel = computed(() => {
    switch (this.check().level) {
      case 1:
        return $localize`:@@auth.invite.strength.weak:Fraca`;
      case 2:
        return $localize`:@@auth.invite.strength.fair:Razoável`;
      case 3:
        return $localize`:@@auth.invite.strength.good:Boa`;
      case 4:
        return $localize`:@@auth.invite.strength.strong:Forte`;
      default:
        return null;
    }
  });
  protected readonly lengthRule = computed<Rule>(() =>
    this.check().meetsMinimum ? 'met' : this.submitted() ? 'invalid' : 'pending',
  );

  protected readonly matches = computed(
    () => this.confirmation().length > 0 && this.confirmation() === this.password(),
  );
  /**
   * Situação da confirmação, em texto e tom. Conferir aparece na hora (é boa notícia); a divergência só depois de o
   * campo perder o foco ou de um envio, e some assim que as senhas conferem. É um indicador, não um erro: o erro de
   * um envio recusado vem na faixa de aviso.
   */
  protected readonly confirmationStatus = computed<{
    readonly tone: 'ok' | 'warn';
    readonly icon: AuthGlyphName;
    readonly text: string;
  } | null>(() => {
    if (this.matches()) {
      return {
        tone: 'ok',
        icon: 'check-circle',
        text: $localize`:@@auth.invite.confirmation-match:As senhas conferem.`,
      };
    }
    if (!this.confirmationTouched() && !this.submitted()) return null;
    if (this.confirmation() === this.password()) return null;
    return {
      tone: 'warn',
      icon: 'warning',
      text:
        this.confirmation().length === 0
          ? $localize`:@@auth.invite.confirmation-empty:Repita a senha para conferir.`
          : $localize`:@@auth.invite.confirmation-mismatch:As senhas ainda não são iguais.`,
    };
  });

  protected readonly emailError = computed(() => {
    if (this.emailTaken()) {
      return $localize`:@@auth.invite.email-taken-field:Escolha outro e-mail.`;
    }
    if (!this.emailTouched() && !this.submitted()) return null;
    const value = this.email().trim();
    if (value.length === 0) return $localize`:@@auth.invite.email-required:Informe o seu e-mail.`;
    return isPlausibleEmail(value)
      ? null
      : $localize`:@@auth.invite.email-format:Confira o e-mail: algo como nome@exemplo.com.`;
  });

  protected readonly banner = computed<AuthBanner | null>(() => {
    // O e-mail recusado (409) explica o que fazer na faixa; o foco vai ao campo, que repete o essencial.
    if (this.emailTaken()) {
      return this.plain(
        'alert-circle',
        $localize`:@@auth.invite.error.email-taken:Este e-mail não pode ser usado.`,
        $localize`:@@auth.invite.error.email-taken-detail:O seu convite continua valendo: escolha outro e-mail e tente de novo.`,
        'warn',
      );
    }
    switch (this.error()) {
      case null:
        return null;
      case 'too-short':
        return this.plain(
          'alert-circle',
          $localize`:@@auth.invite.error.too-short:A senha precisa ter ao menos ${MIN_PASSWORD_LENGTH}:min: caracteres.`,
        );
      case 'mismatch':
        return this.plain(
          'alert-circle',
          $localize`:@@auth.invite.error.mismatch:As duas senhas não são iguais.`,
        );
      case 'bad-request':
        return this.plain(
          'alert-circle',
          $localize`:@@auth.invite.error.bad-request:Confira o e-mail e a senha digitados.`,
        );
      case 'rate-limited':
        return this.rateLimitBanner();
      case 'network':
        return this.plain(
          'wifi-off',
          $localize`:@@auth.invite.error.network:Sem conexão com o servidor.`,
          $localize`:@@auth.invite.error.network-detail:Verifique a sua internet e tente de novo.`,
          'warn',
        );
      default:
        return this.plain(
          'alert-circle',
          $localize`:@@auth.invite.error.failed:Não foi possível criar a conta agora.`,
          $localize`:@@auth.invite.error.failed-detail:Algo deu errado do nosso lado. Tente de novo em instantes.`,
          'warn',
        );
    }
  });

  private announced: PasswordAnnouncement = { met: false, level: 0, match: false };
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  private continued = false;

  constructor() {
    const fragment = this.route.snapshot.fragment;
    this.view.set(fragment ? 'form' : 'missing');
    if (fragment) this.readFragment(fragment);
    // Quem cola outro link de convite na mesma aba só muda o fragmento: a tela acompanha. (A emissão vazia que vem
    // de tirar o segredo do endereço é ignorada.)
    this.route.fragment
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe((next) => next && this.readFragment(next));
    inject(DestroyRef).onDestroy(() => {
      this.wait.stop();
      clearTimeout(this.announceTimer);
      clearTimeout(this.welcomeTimer);
    });
  }

  /** A cada mudança nas senhas: espera a digitação parar e só então fala o que mudou. */
  protected scheduleAnnouncement(): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => this.announce(), ANNOUNCE_DELAY_MS);
  }

  protected editEmail(): void {
    this.emailTaken.set(false);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const secret = this.#secret;
    if (this.busy() || this.blocked() || secret === null) return;

    this.submitted.set(true);
    this.error.set(null);
    // Dado inválido: o foco vai para o primeiro campo com problema, sem ir ao servidor.
    if (this.emailError()) return this.emailField()?.focus();
    if (!this.check().meetsMinimum) return this.refuse('too-short', this.passwordField());
    if (this.password() !== this.confirmation()) {
      return this.refuse('mismatch', this.confirmationField());
    }

    this.busy.set(true);
    try {
      await this.auth.acceptInvite(secret, this.email().trim(), this.password());
      this.password.set('');
      this.confirmation.set('');
      this.welcome();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  /** Segue para o app: o guarda de papel leva a convidada direto ao controle da TV. */
  protected continueToApp(): void {
    if (this.continued) return;
    this.continued = true;
    clearTimeout(this.welcomeTimer);
    void this.router.navigateByUrl('/', { replaceUrl: true });
  }

  /** Guarda o segredo se ele tem a forma certa, escolhe a tela e o tira do endereço (e do histórico). */
  private readFragment(fragment: string): void {
    const valid = INVITE_SECRET.test(fragment);
    this.#secret = valid ? fragment : null;
    if (this.view() !== 'welcome') {
      this.view.set(valid ? 'form' : 'incomplete');
      this.error.set(null);
    }
    void this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
  }

  private welcome(): void {
    this.view.set('welcome');
    afterNextRender(() => this.stateBox()?.focus(), { injector: this.injector });
    this.welcomeTimer = setTimeout(() => this.continueToApp(), WELCOME_MS);
  }

  private refuse(kind: InviteError, field: AuthField | undefined): void {
    this.error.set(kind);
    field?.focus();
  }

  private fail(error: unknown): void {
    const problem = error instanceof ApiProblem ? error : null;
    switch (problem?.status) {
      case 410:
        // Vencido, já usado ou revogado: a API não diz qual, e o convite não serve mais para nada.
        this.view.set('gone');
        afterNextRender(() => this.stateBox()?.focus(), { injector: this.injector });
        return;
      case 409:
        this.emailTaken.set(true);
        afterNextRender(() => this.emailField()?.focus(true), { injector: this.injector });
        return;
      case 400:
        this.error.set('bad-request');
        break;
      case 429:
        this.error.set('rate-limited');
        this.waitTotal.set(Math.max(0, Math.ceil(problem.retryAfterSeconds ?? 0)));
        this.wait.start(this.waitTotal());
        break;
      default:
        this.error.set(problem?.isNetwork ? 'network' : 'failed');
    }
    // O erro é anunciado (role="alert") e recebe o foco, para quem usa leitor de tela ou teclado.
    afterNextRender(() => this.notice()?.focus(), { injector: this.injector });
  }

  private plain(
    icon: AuthGlyphName,
    heading: string,
    detail: string | null = null,
    tone: 'bad' | 'warn' = 'bad',
  ): AuthBanner {
    return { tone, role: 'alert', icon, heading, detail, waiting: false };
  }

  /** Limite de tentativas: conta a espera e, quando ela acaba, vira "pronto" sozinha (sem tempo do servidor, só avisa). */
  private rateLimitBanner(): AuthBanner {
    if (this.waitTotal() > 0 && !this.blocked()) {
      return {
        tone: 'ok',
        role: 'status',
        icon: 'check-circle',
        heading: $localize`:@@auth.invite.wait-over:Pronto, você já pode tentar de novo.`,
        detail: null,
        waiting: false,
      };
    }
    return {
      tone: 'warn',
      role: 'alert',
      icon: 'clock',
      heading: $localize`:@@auth.invite.error.rate-limited:Muitas tentativas seguidas.`,
      detail: $localize`:@@auth.invite.error.rate-limited-detail:Espere um pouco antes de tentar de novo.`,
      waiting: this.blocked(),
    };
  }

  /** Fala só o que mudou desde a última vez: requisito cumprido ou pendente, força nova, senhas que passaram a conferir. */
  private announce(): void {
    const check = this.check();
    const now: PasswordAnnouncement = {
      met: check.meetsMinimum,
      level: check.level,
      match: this.matches(),
    };
    const before = this.announced;
    const parts: string[] = [];
    if (now.met !== before.met) {
      parts.push(
        now.met
          ? $localize`:@@auth.invite.live.met:Requisito cumprido: ao menos ${MIN_PASSWORD_LENGTH}:min: caracteres.`
          : $localize`:@@auth.invite.live.unmet:Requisito pendente: ao menos ${MIN_PASSWORD_LENGTH}:min: caracteres.`,
      );
    }
    if (now.met && now.level !== before.level) {
      parts.push(
        $localize`:@@auth.invite.live.strength:Força da senha: ${this.strengthLabel()}:label:.`,
      );
    }
    if (now.match !== before.match && this.confirmation().length > 0) {
      parts.push(
        now.match
          ? $localize`:@@auth.invite.live.match:As senhas conferem.`
          : $localize`:@@auth.invite.live.mismatch:As senhas não conferem.`,
      );
    }
    this.announced = now;
    if (parts.length > 0) this.announcement.set(parts.join(' '));
  }
}
