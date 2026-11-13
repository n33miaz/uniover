import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ShoppingSession } from './shopping-session';

/**
 * O que as telas que dependem das Compras do aparelho (Lista, Mercado Agora, Histórico e a entrada) mostram enquanto a
 * lista não abriu: a espera, ou, se o banco do aparelho não abriu, o aviso com o botão de tentar de novo. Detalhes não
 * usa isto: gere pessoas, convites e importação pela API, sem o banco do aparelho, e segue aberta na falha.
 */
@Component({
  selector: 'app-shopping-opening',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.failed()) {
      <p class="ui-notice warn failed" role="alert">
        <span i18n="@@shopping.open-failed">Não foi possível abrir a lista neste aparelho.</span>
        <button type="button" class="ui-btn" (click)="session.retry()" i18n="@@shopping.open-retry">
          Tentar de Novo
        </button>
      </p>
    } @else {
      <div class="ui-group" aria-hidden="true">
        <div class="ui-row"><span class="ui-skeleton ui-wait line"></span></div>
        <div class="ui-row"><span class="ui-skeleton ui-wait line"></span></div>
      </div>
      <p class="ui-visually-hidden" role="status" i18n="@@shopping.loading">Abrindo a lista</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .line {
      width: 60%;
      height: 1rem;
    }
    .failed {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
  `,
})
export class ShoppingOpening {
  protected readonly session = inject(ShoppingSession);
}
