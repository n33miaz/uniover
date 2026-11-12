import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ShoppingActions } from './shopping-actions';
import { formatDay, formatMoney, formatQuantity } from './shopping-format';
import { ShoppingItemIcon } from './shopping-item-icon';
import { closedPurchases, purchaseLines, type MarketRow, type Purchase } from './shopping-model';

/** O histórico: uma linha por compra fechada (dia, loja, total). Um toque abre o que foi comprado nela. */
@Component({
  selector: 'app-shopping-history-page',
  imports: [ShoppingItemIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-history.page.css'],
  template: `
    <section class="screen" [attr.data-screen-ready]="'shopping'">
      <ul class="ui-group">
        @for (past of history(); track past.id) {
          <li>
            <button
              type="button"
              class="ui-row trip"
              [attr.aria-expanded]="selected() === past.id"
              (click)="toggle(past)"
            >
              <span class="ui-row-text">
                <span class="ui-row-title">
                  @if (past.store) {
                    {{ past.store }}
                  } @else {
                    <ng-container i18n="@@shopping.history.no-store">Compra</ng-container>
                  }
                </span>
                <span class="ui-row-sub">{{ day(past) }}</span>
              </span>
              <strong class="money">{{ money(past.totalPaid) }}</strong>
            </button>
            @if (selected() === past.id) {
              <ul class="lines">
                @for (row of lines(); track row.product.id) {
                  <li class="detail">
                    <app-shopping-item-icon [product]="row.product" />
                    <span class="ui-row-text">
                      <span class="name">{{ row.product.name }}</span>
                      @if (sub(row); as text) {
                        <span class="ui-row-sub">{{ text }}</span>
                      }
                    </span>
                    @if (row.unitPrice !== null) {
                      <span class="money">{{ money(row.unitPrice * row.quantity) }}</span>
                    }
                  </li>
                } @empty {
                  <li class="hint none" i18n="@@shopping.history.no-items">Sem itens guardados.</li>
                }
              </ul>
            }
          </li>
        } @empty {
          <li class="empty" i18n="@@shopping.history.empty">Nenhuma compra ainda.</li>
        }
      </ul>
    </section>
  `,
})
export class ShoppingHistoryPage {
  private readonly actions = inject(ShoppingActions);
  protected readonly selected = signal<string | null>(null);
  protected readonly history = computed(() => closedPurchases(this.actions.snapshot()));
  protected readonly lines = computed(() => {
    const id = this.selected();
    return id ? purchaseLines(this.actions.snapshot(), id).filter((row) => row.picked) : [];
  });

  protected toggle(purchase: Purchase): void {
    this.selected.update((current) => (current === purchase.id ? null : purchase.id));
  }

  protected money(value: number | null | undefined): string {
    return formatMoney(value ?? 0);
  }

  protected day(purchase: Purchase): string {
    return formatDay(purchase.closedAt);
  }

  protected sub(row: MarketRow): string {
    const parts: string[] = [];
    if (row.quantity !== 1 || row.product.unit) {
      const each = row.unitPrice !== null ? ` × ${formatMoney(row.unitPrice)}` : '';
      parts.push(formatQuantity(row.quantity, row.product.unit) + each);
    }
    if (row.promoNote) parts.push(row.promoNote);
    return parts.join(' · ');
  }
}
