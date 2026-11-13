import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { AuthLayout } from '../../core/auth/auth-layout';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { ShoppingPeopleApi } from './shopping-people-api';

/** A forma do segredo do convite (o mesmo Base64Url de 32 bytes que o servidor gera). */
const INVITE_SECRET = /^[A-Za-z0-9_-]{20,64}$/;

/** O endereço da tela, sempre sem o segredo: é o que fica no histórico e o que vai no `next` do login. */
export const JOIN_PATH = '/compras/convite';

/** Onde o segredo espera enquanto a pessoa entra (só nesta aba; apagado na volta, antes do pedido). */
export const JOIN_SECRET_KEY = 'uniover.shopping.invite';

function stash(secret: string): void {
  try {
    sessionStorage.setItem(JOIN_SECRET_KEY, secret);
  } catch {
    // Sem armazenamento (aba privada restrita): o segredo fica só em memória, e vale se a sessão já existir.
  }
}

/** Lê e apaga: o segredo nunca fica guardado depois de usado. */
function unstash(): string | null {
  try {
    const secret = sessionStorage.getItem(JOIN_SECRET_KEY);
    sessionStorage.removeItem(JOIN_SECRET_KEY);
    return secret && INVITE_SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

type JoinState = 'joining' | 'invalid' | 'elsewhere' | 'forbidden' | 'offline' | 'failed';

/**
 * A entrada pelo convite do grupo de Compras (`/compras/convite#segredo`, do link ou do QR). O segredo vem no
 * fragmento, que o navegador nunca envia a ninguém. A tela fica fora da casca e sem guarda (como `/convite`): guarda
 * nenhum chega a ver o fragmento, e ele nunca vai para o `?next=` do login nem da pergunta do nome. Antes de qualquer
 * navegação a tela guarda o segredo nesta aba (sessionStorage) e tira o fragmento do endereço e do histórico. Sem
 * sessão, vai para o login com `next=/compras/convite`; na volta, lê o segredo, apaga e só então o manda no corpo do
 * pedido. Deu certo, segue para Compras.
 */
@Component({
  selector: 'app-shopping-join-page',
  imports: [AuthLayout, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shopping-screen.css',
  // O título segue o das outras telas de entrada (tamanho dado pelo cartão, numa linha).
  styles: `
    h1 {
      margin-bottom: var(--space-5);
      font-size: var(--auth-title);
      font-weight: 750;
      letter-spacing: -0.02em;
      text-align: center;
      text-wrap: balance;
    }
  `,
  template: `
    <app-auth-layout [attr.data-screen-ready]="'shopping'">
      <h1 i18n="@@shopping.join.title">Convite para as Compras</h1>
      @switch (state()) {
        @case ('joining') {
          <p class="empty" role="status" i18n="@@shopping.join.joining">Entrando no grupo…</p>
        }
        @case ('invalid') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.join.invalid">
            Este convite não vale mais. Peça outro a quem convidou.
          </p>
        }
        @case ('elsewhere') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.join.elsewhere">
            Você já tem uma lista com itens. Esvazie a sua ou saia do seu grupo antes.
          </p>
        }
        @case ('forbidden') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.join.forbidden">
            Sua conta ainda não usa as Compras. Peça a quem convidou para liberar.
          </p>
        }
        @case ('offline') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.people.offline">
            Sem sinal. Tente de novo quando voltar.
          </p>
          <button type="button" class="ui-btn block" (click)="join()" i18n="@@shopping.join.retry">
            Tentar de Novo
          </button>
        }
        @case ('failed') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.people.failed">
            Não deu certo. Tente de novo.
          </p>
          <button type="button" class="ui-btn block" (click)="join()" i18n="@@shopping.join.retry">
            Tentar de Novo
          </button>
        }
      }
      @if (state() !== 'joining') {
        <a class="ui-btn block" routerLink="/" i18n="@@shopping.join.home">Ir para o Início</a>
      }
    </app-auth-layout>
  `,
})
export class ShoppingJoinPage {
  private readonly api = inject(ShoppingPeopleApi);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly state = signal<JoinState>('joining');
  /** Depois de lido do armazenamento, só em memória (para o "Tentar de novo"): nunca na tela. */
  #secret: string | null = null;
  /** O roteador esquecendo o fragmento (ver o construtor). */
  readonly #forgotten: Promise<unknown>;

  constructor() {
    // Tudo isto antes de qualquer espera ou navegação: o segredo sai do endereço já.
    const fragment = this.route.snapshot.fragment;
    if (fragment && INVITE_SECRET.test(fragment)) stash(fragment);
    if (fragment !== null || location.pathname !== JOIN_PATH || location.search) {
      history.replaceState(null, '', JOIN_PATH);
    }
    // O roteador ainda guarda o endereço com o fragmento e o devolveria à barra numa navegação que falhasse (sem sinal,
    // por exemplo). Navegar para o mesmo caminho limpo o faz esquecer; a tela continua a mesma.
    this.#forgotten =
      fragment !== null
        ? this.router.navigateByUrl(JOIN_PATH, { replaceUrl: true }).catch(() => false)
        : Promise.resolve(true);
    void this.start();
  }

  private async start(): Promise<void> {
    await this.#forgotten;
    await this.auth.init();
    if (this.auth.status() === 'anonymous') {
      await this.router.navigateByUrl(this.auth.loginUrlTree(JOIN_PATH), { replaceUrl: true });
      return;
    }
    // Conta nova: a pergunta do nome vem antes, e volta para cá (o segredo continua guardado nesta aba).
    await this.auth.ensureUser();
    if (this.session.needsWelcome()) {
      await this.router.navigateByUrl(this.auth.welcomeUrlTree(JOIN_PATH), { replaceUrl: true });
      return;
    }
    this.#secret = unstash();
    await this.join();
  }

  protected async join(): Promise<void> {
    const secret = this.#secret;
    if (!secret) {
      this.state.set('invalid');
      return;
    }
    this.state.set('joining');
    try {
      await this.api.acceptInvite(secret);
      await this.router.navigateByUrl('/compras', { replaceUrl: true });
    } catch (error) {
      const problem = problemOf(error);
      if (problem?.isNetwork) this.state.set('offline');
      else if (problem?.status === 410) this.state.set('invalid');
      else if (problem?.status === 403) this.state.set('forbidden');
      else if (problem?.kind === 'shopping-member-in-another-group') this.state.set('elsewhere');
      else this.state.set('failed');
    }
  }
}
