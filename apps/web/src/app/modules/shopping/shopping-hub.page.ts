import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ShoppingActions } from './shopping-actions';
import { closedPurchases, neededCount, pickedTotal } from './shopping-model';
import { formatDay, formatMoney } from './shopping-format';

// Desenhos da entrada, em grade de 24: lista com marcas, carrinho, relógio e engrenagem.
const ICONS = {
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2',
  cart: 'M3 4h2l2.4 11h10.2L20 8H6.2 M9 19.5a1 1 0 1 0 0 .1 M17 19.5a1 1 0 1 0 0 .1',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.7H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.3 3V3a2 2 0 0 1 4 0v.1A1.7 1.7 0 0 0 17 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z',
};

/**
 * A entrada de Compras: três caminhos grandes, um toque cada. Lista (para comprar depois), Mercado Agora (a compra em
 * andamento, ou começar uma) e, menor, o Histórico. Detalhes (quem vê, convites) fica no canto, como uma configuração.
 */
@Component({
  selector: 'app-shopping-hub-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-hub.page.css'],
  template: `
    <section class="screen" [attr.data-screen-ready]="'shopping'">
      @if (!actions.store()) {
        <div class="ui-group" aria-hidden="true">
          <div class="ui-row"><span class="ui-skeleton ui-wait line"></span></div>
          <div class="ui-row"><span class="ui-skeleton ui-wait line"></span></div>
        </div>
        <p class="ui-visually-hidden" role="status" i18n="@@shopping.loading">Abrindo a lista</p>
      } @else {
        <nav class="paths" aria-label="Compras" i18n-aria-label="@@shopping.hub.label">
          <a class="path" routerLink="lista">
            <span class="glyph" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path [attr.d]="icons.list" /></svg
            ></span>
            <span class="text">
              <span class="title" i18n="@@shopping.list.title">Lista</span>
              <span class="sub">
                @if (listCount() > 0) {
                  <ng-container i18n="@@shopping.hub.list-count"
                    >{{ listCount() }} para comprar</ng-container
                  >
                } @else {
                  <ng-container i18n="@@shopping.hub.list-empty"
                    >Monte para comprar depois</ng-container
                  >
                }
              </span>
            </span>
          </a>
          <a class="path market" routerLink="mercado">
            <span class="glyph" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path [attr.d]="icons.cart" /></svg
            ></span>
            <span class="text">
              <span class="title" i18n="@@shopping.market.title">Mercado Agora</span>
              <span class="sub">
                @if (open()) {
                  <ng-container i18n="@@shopping.hub.market-open"
                    >Em andamento · {{ total() }}</ng-container
                  >
                } @else {
                  <ng-container i18n="@@shopping.hub.market-start"
                    >Com a lista ou do zero</ng-container
                  >
                }
              </span>
            </span>
          </a>
        </nav>

        <div class="ui-group">
          <a class="ui-row" routerLink="historico">
            <span class="ui-tile" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path [attr.d]="icons.clock" /></svg
            ></span>
            <span class="ui-row-text">
              <span class="ui-row-title" i18n="@@shopping.history.title">Histórico</span>
              <span class="ui-row-sub">
                @if (last(); as past) {
                  {{ day(past.closedAt) }} · {{ money(past.totalPaid) }}
                } @else {
                  <ng-container i18n="@@shopping.history.none-yet"
                    >Nenhuma compra ainda</ng-container
                  >
                }
              </span>
            </span>
          </a>
          <a class="ui-row" routerLink="detalhes">
            <span class="ui-tile" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path [attr.d]="icons.gear" /></svg
            ></span>
            <span class="ui-row-text">
              <span class="ui-row-title" i18n="@@shopping.details.title">Detalhes</span>
              <span class="ui-row-sub" i18n="@@shopping.hub.details-hint">Quem vê e convites</span>
            </span>
          </a>
        </div>
      }
    </section>
  `,
})
export class ShoppingHubPage {
  protected readonly actions = inject(ShoppingActions);
  protected readonly icons = ICONS;

  protected readonly listCount = computed(() => neededCount(this.actions.snapshot()));
  protected readonly open = computed(() => this.actions.purchase());
  protected readonly total = computed(() => formatMoney(pickedTotal(this.actions.rows())));
  protected readonly last = computed(() => closedPurchases(this.actions.snapshot())[0] ?? null);

  protected money(value: number | null | undefined): string {
    return formatMoney(value ?? 0);
  }

  protected day(value: string | null | undefined): string {
    return formatDay(value);
  }
}
