import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { ShoppingPeopleApi } from './shopping-people-api';

/** A forma do segredo do convite (o mesmo Base64Url de 32 bytes que o servidor gera). */
const INVITE_SECRET = /^[A-Za-z0-9_-]{20,64}$/;

type JoinState = 'joining' | 'invalid' | 'elsewhere' | 'forbidden' | 'offline' | 'failed';

/**
 * A entrada pelo convite do grupo de Compras (`/compras/convite#segredo`, do link ou do QR). O segredo vem no
 * fragmento, que o navegador nunca envia a ninguém; a tela o tira do endereço e o manda no corpo do pedido. Quem ainda
 * não entrou passa pelo login e volta aqui com o fragmento. Deu certo, segue para Compras.
 */
@Component({
  selector: 'app-shopping-join-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shopping-screen.css',
  template: `
    <section class="screen" [attr.data-screen-ready]="'shopping-join'">
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
          <button
            type="button"
            class="ui-btn block"
            (click)="join()"
            i18n="@@shopping.people.retry"
          >
            Tentar de novo
          </button>
        }
        @case ('failed') {
          <p class="ui-notice warn" role="alert" i18n="@@shopping.people.failed">
            Não deu certo. Tente de novo.
          </p>
          <button
            type="button"
            class="ui-btn block"
            (click)="join()"
            i18n="@@shopping.people.retry"
          >
            Tentar de novo
          </button>
        }
      }
      @if (state() !== 'joining') {
        <a class="ui-btn block" routerLink="/" i18n="@@shopping.join.home">Ir para o Início</a>
      }
    </section>
  `,
})
export class ShoppingJoinPage {
  private readonly api = inject(ShoppingPeopleApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly state = signal<JoinState>('joining');
  /** Só em memória: nunca na tela nem no armazenamento. */
  #secret: string | null = null;

  constructor() {
    const fragment = this.route.snapshot.fragment;
    this.#secret = fragment && INVITE_SECRET.test(fragment) ? fragment : null;
    // Tira o segredo do endereço (e do histórico).
    void this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
    void this.join();
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
