import { Component, effect, inject, untracked } from '@angular/core';
import { SessionState } from '../session/session-state';
import { userCan } from '../session/access';
import { TvPermissionSheet } from './tv-permission-sheet';
import { TvPermissionService } from './tv-permission.service';

/** Permissão do catálogo da API que libera o módulo da TV. */
const TV_MODULE_PERMISSION = 'module:tv';

/**
 * Hospeda, na casca, a folha "Permissão da TV". Ao entrar (sessão confirmada e conta com a TV) pergunta à API se alguma
 * TV da conta precisa do aceite na tela dela; se precisar, a folha abre na hora, antes de qualquer outra tela (é um
 * diálogo modal: o resto fica inerte até a pessoa responder). Sem TV pendente não desenha nada.
 *
 * "Depois" adia só nesta visita (o serviço lembra por aba). Erro de rede ou resposta estranha nunca prende ninguém: a
 * lista fica vazia e o app segue como sempre.
 */
@Component({
  selector: 'app-tv-permission',
  imports: [TvPermissionSheet],
  template: `
    @if (permission.current(); as tv) {
      @for (item of [tv]; track item.tvId) {
        <app-tv-permission-sheet
          [tvId]="item.tvId"
          [tvName]="item.name"
          [showName]="permission.pending().length > 1"
          (later)="permission.dismiss(item.tvId)"
          (closed)="closed($event)"
        />
      }
    }
  `,
})
export class TvPermissionHost {
  protected readonly permission = inject(TvPermissionService);
  private readonly session = inject(SessionState);
  private checkedFor: string | null = null;

  constructor() {
    effect(() => {
      if (!this.session.isAuthenticated()) {
        this.checkedFor = null;
        return;
      }
      const account = this.session.accountId();
      if (account === null || !userCan(this.session.user(), TV_MODULE_PERMISSION)) return;
      // Uma leitura por conta e por visita: trocar de conta lê de novo, voltar ao app não repete.
      if (untracked(() => this.checkedFor) === account) return;
      this.checkedFor = account;
      untracked(() => void this.permission.refresh());
    });
  }

  /** A folha saiu: com o aceite dado, a lista é lida de novo (a próxima TV pendente, se houver, aparece). */
  protected closed(granted: boolean): void {
    if (granted) void this.permission.refresh();
  }
}
