import { DOCUMENT } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SessionState } from '../session/session-state';
import { AuthField } from './auth-field';
import { AuthGlyphName } from './auth-glyph';
import { AuthLayout } from './auth-layout';
import { AuthBanner, AuthNotice } from './auth-notice';
import { AuthService } from './auth.service';
import {
  DISPLAY_NAME_INPUT_LIMIT,
  DisplayNameFailure,
  MAX_DISPLAY_NAME,
  describeDisplayNameFailure,
  displayNameCounterText,
  displayNameIssue,
  displayNameIssueText,
  displayNameLength,
  normalizeDisplayName,
} from './display-name';
import { safeNextUrl } from './next-url';

const BANNER_ICONS: Record<Exclude<DisplayNameFailure['kind'], 'field'>, AuthGlyphName> = {
  network: 'wifi-off',
  wait: 'clock',
  revoked: 'lock',
  failed: 'alert-circle',
};

/**
 * Primeiro acesso: pergunta como a pessoa quer ser chamada, antes de qualquer outra tela (o guarda manda para cá quem
 * ainda não escolheu o nome). Serve a administrador e a convidada: o campo já vem com o nome que a conta tem (o pedaço do
 * e-mail antes do `@` ou o nome do convite), e a pessoa pode aceitá-lo ou trocá-lo. Depois de salvar, volta ao destino
 * original (`next`, só se for um caminho seguro da própria origem).
 *
 * Mesma identidade e mesma validação gentil do login: o aviso do campo só aparece depois de ele perder o foco ou de um
 * envio, nunca a cada tecla. Falha ao salvar (sem rede, limite, servidor) fica na tela e deixa tentar de novo: nada aqui
 * prende a pessoa nem navega sozinho em caso de erro. Quem já escolheu o nome nunca vê esta tela (é levado ao destino).
 */
@Component({
  selector: 'app-welcome-page',
  imports: [AuthLayout, AuthField, AuthNotice],
  templateUrl: './welcome.page.html',
  styleUrl: './welcome.page.css',
})
export class WelcomePage {
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  private readonly nameField = viewChild.required<AuthField>('nameField');
  private readonly notice = viewChild(AuthNotice);

  protected readonly inputLimit = DISPLAY_NAME_INPUT_LIMIT;

  /** Já vem com o nome que a conta tem hoje (também se o usuário chegar depois da tela): aceitar custa um toque. */
  protected readonly name = linkedSignal(() => this.session.user()?.displayName ?? '');
  protected readonly touched = signal(false);
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<DisplayNameFailure | null>(null);
  /** A mensagem de campo que a API devolveu; some assim que a pessoa mexe no texto. */
  private readonly serverFieldError = signal<string | null>(null);
  private readonly leaving = signal(false);

  protected readonly sending = computed(() => this.busy() || this.leaving());
  protected readonly counter = computed(() => displayNameCounterText(this.name()));
  protected readonly overLimit = computed(() => displayNameLength(this.name()) > MAX_DISPLAY_NAME);

  protected readonly nameError = computed(() => {
    // Passar do limite avisa na hora (a pessoa ainda está digitando e o contador já mostra); vazio só depois de sair do campo.
    const issue = displayNameIssue(this.name());
    if (issue && (issue === 'too-long' || this.touched() || this.submitted())) {
      return displayNameIssueText(issue);
    }
    return this.serverFieldError();
  });

  protected readonly banner = computed<AuthBanner | null>(() => {
    const failure = this.failure();
    if (!failure || failure.kind === 'field') return null;
    return {
      tone: failure.kind === 'revoked' ? 'bad' : 'warn',
      role: 'alert',
      icon: BANNER_ICONS[failure.kind],
      heading: failure.heading,
      detail: failure.detail,
      waiting: false,
    };
  });

  constructor() {
    // No computador o cursor já cai no campo, com o nome inteiro selecionado. No celular não: focar sozinho abre o
    // teclado e esconde a tela antes de a pessoa ler a pergunta (e, para leitor de tela, pularia o título).
    afterNextRender(() => {
      const pointer = this.doc.defaultView?.matchMedia?.('(hover: hover) and (pointer: fine)');
      if (pointer?.matches) this.nameField().focus(true);
    });
    // Quem já escolheu o nome (ou não tem usuário carregado) não tem o que fazer aqui: segue para o destino.
    void this.auth.init().then(() => {
      if (!this.session.needsWelcome()) void this.leave();
    });
  }

  protected edit(): void {
    this.serverFieldError.set(null);
    this.failure.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.sending()) return;
    this.submitted.set(true);
    this.failure.set(null);
    this.serverFieldError.set(null);
    if (displayNameIssue(this.name())) return this.nameField().focus();

    this.busy.set(true);
    try {
      await this.auth.updateDisplayName(normalizeDisplayName(this.name()));
      this.leaving.set(true);
      await this.leave();
      this.leaving.set(false);
    } catch (error) {
      this.fail(describeDisplayNameFailure(error));
    } finally {
      this.busy.set(false);
    }
  }

  private fail(failure: DisplayNameFailure): void {
    this.failure.set(failure);
    if (failure.kind === 'field') {
      this.serverFieldError.set(failure.field);
      afterNextRender(() => this.nameField().focus(), { injector: this.injector });
      return;
    }
    // O aviso é anunciado (role="alert") e recebe o foco, para quem usa leitor de tela ou teclado.
    afterNextRender(() => this.notice()?.focus(), { injector: this.injector });
  }

  private leave(): Promise<boolean> {
    const next = safeNextUrl(
      this.route.snapshot.queryParamMap.get('next'),
      this.doc.defaultView?.location.origin ?? 'http://localhost',
    );
    return this.router.navigateByUrl(next ?? '/', { replaceUrl: true });
  }
}
