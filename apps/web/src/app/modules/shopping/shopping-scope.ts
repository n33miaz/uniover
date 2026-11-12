import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ShoppingActions } from './shopping-actions';
import { ShoppingSession } from './shopping-session';

/**
 * Em volta de todas as telas de Compras: abre as Compras da conta (`ShoppingSession`, uma por visita ao módulo, então
 * fora dele nada é lido nem enviado) e mostra o estado do envio e o recado do último envio. As telas filhas (entrada,
 * Lista, Mercado Agora, Histórico e Detalhes) dividem a mesma fila e o mesmo retrato.
 */
@Component({
  selector: 'app-shopping-scope',
  imports: [RouterOutlet],
  providers: [ShoppingSession, ShoppingActions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sync" role="status">
      @switch (syncState()) {
        @case ('offline') {
          <span class="ui-chip warn" i18n="@@shopping.sync.offline">Sem sinal</span>
        }
        @case ('pending') {
          <span class="ui-chip" i18n="@@shopping.sync.pending">Salvando</span>
        }
        @case ('attention') {
          @if (pendingCount() > 0) {
            <button type="button" class="ui-btn" (click)="retry()" i18n="@@shopping.sync.retry">
              Tentar Enviar de Novo
            </button>
          }
        }
      }
    </div>
    @if (syncNotice(); as text) {
      <p class="ui-notice warn sync-notice" role="alert">
        <span>{{ text }}</span>
        <button type="button" class="ui-btn" (click)="dismiss()" i18n="@@shopping.notice.dismiss">
          Entendi
        </button>
      </p>
    }
    <router-outlet />
  `,
  styles: `
    :host {
      display: block;
    }
    /* Discreto: some quando está tudo enviado e não empurra a tela quando aparece. */
    .sync {
      display: flex;
      justify-content: center;
      margin-bottom: var(--space-3);
    }
    .sync:empty {
      display: none;
    }
    .sync-notice {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      max-width: 40rem;
      margin: 0 auto var(--space-3);
    }
  `,
})
export class ShoppingScope {
  private readonly session = inject(ShoppingSession);
  protected readonly syncState = computed(() => this.session.store()?.state() ?? 'synced');
  protected readonly pendingCount = computed(() => this.session.store()?.pendingCount() ?? 0);

  /** O recado do último envio: uma mudança que o servidor não aceitou nunca some calada. */
  protected readonly syncNotice = computed(() => {
    switch (this.session.store()?.notice()) {
      case 'refused':
        return $localize`:@@shopping.notice.refused:Uma mudança não foi aceita e foi desfeita. Confira a lista.`;
      case 'merged':
        return $localize`:@@shopping.notice.merged:Já havia uma compra aberta. O que você marcou foi para ela.`;
      case 'joined':
        return $localize`:@@shopping.notice.joined:Juntamos itens repetidos.`;
      default:
        return null;
    }
  });

  protected retry(): void {
    void this.session.store()?.sync();
  }

  protected dismiss(): void {
    this.session.store()?.notice.set(null);
  }
}
