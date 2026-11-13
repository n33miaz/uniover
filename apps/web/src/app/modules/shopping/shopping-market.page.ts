import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ShoppingActions } from './shopping-actions';
import { ShoppingAdviceCard } from './shopping-advice-card';
import { categoryLabel, variantsOf, type CategoryKey } from './shopping-categories';
import { parseEntry } from './shopping-entry';
import { formatMoney, formatQuantity, moneyField } from './shopping-format';
import { ShoppingItemIcon } from './shopping-item-icon';
import { ShoppingOpening } from './shopping-opening';
import { ShoppingItemSheet, type SheetResult } from './shopping-item-sheet';
import {
  budgetState,
  byCategory,
  lineTotal,
  neededCount,
  parseMoney,
  pickedSavings,
  pickedTotal,
  type MarketRow,
} from './shopping-model';
import { suggestNames } from './shopping-suggest';

/**
 * Mercado Agora. Sem compra aberta, a pessoa escolhe: usar a lista (o que "precisa" vira o que pegar) ou começar do zero.
 * Com a compra aberta: o total no alto (com o teto e o que a promoção economizou), o que falta pegar por corredor, o que
 * já está no carrinho e, embaixo, o campo único: "leite 5,49" ou "arroz 2x 12,90" põe o item, a quantidade e o preço
 * de uma vez, já como pego. Um toque no item = peguei; um toque no preço abre a folha (preço, promoção, tipo).
 * Tudo funciona sem sinal: vai para a fila do aparelho.
 */
@Component({
  selector: 'app-shopping-market-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    ShoppingAdviceCard,
    ShoppingItemIcon,
    ShoppingItemSheet,
    ShoppingOpening,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-market.page.css'],
  templateUrl: './shopping-market.page.html',
})
export class ShoppingMarketPage {
  protected readonly actions = inject(ShoppingActions);
  private readonly router = inject(Router);

  protected readonly draft = signal('');
  protected readonly notice = signal<string | null>(null);
  protected readonly editingBudget = signal(false);
  protected readonly closing = signal(false);
  protected readonly lastAdded = signal<string | null>(null);
  protected readonly open = signal<{ readonly productId: string; readonly price: boolean } | null>(
    null,
  );

  protected readonly purchase = this.actions.purchase;
  protected readonly listCount = computed(() => neededCount(this.actions.snapshot()));
  protected readonly rows = this.actions.rows;
  protected readonly toPick = computed(() =>
    byCategory(
      this.rows().filter((row) => !row.picked),
      (row) => row.product,
      (a, b) => a.product.name.localeCompare(b.product.name),
    ),
  );
  protected readonly inCart = computed(() => this.rows().filter((row) => row.picked));
  protected readonly total = computed(() => pickedTotal(this.rows()));
  protected readonly savings = computed(() => pickedSavings(this.rows()));
  protected readonly budget = computed(() => budgetState(this.total(), this.purchase()?.budget));
  /** A compra foi aberta sem sinal e ainda não chegou ao servidor. */
  protected readonly waiting = computed(() => {
    const purchase = this.purchase();
    return !!purchase && this.actions.store()?.unconfirmedPurchase() === purchase.id;
  });
  protected readonly lastPrices = computed(() => this.actions.store()?.lastPrices() ?? new Map());
  protected readonly suggestions = computed(() =>
    suggestNames(this.actions.snapshot(), this.draft()),
  );
  /** O que o campo vai pôr, para a pessoa conferir antes do Enter. */
  protected readonly preview = computed(() => {
    const entry = parseEntry(this.draft(), this.actions.entryCategory);
    if (!entry || (entry.unitPrice === null && entry.quantity === 1 && !entry.promo)) return null;
    const parts = [entry.name];
    if (entry.quantity !== 1 || entry.unit) parts.push(formatQuantity(entry.quantity, entry.unit));
    if (entry.unitPrice !== null) {
      parts.push(
        entry.unit === 'kg'
          ? $localize`:@@shopping.entry.per-kg:${formatMoney(entry.unitPrice)}:price:/kg`
          : formatMoney(entry.unitPrice),
      );
    }
    if (entry.promo) parts.push($localize`:@@shopping.promo.short:promo`);
    // O total da linha sempre à vista: é o que entra na conta da compra, e mostra na hora um peso lido errado.
    if (entry.unitPrice !== null) {
      parts.push(
        $localize`:@@shopping.entry.line-total:total ${formatMoney(lineTotal(entry.quantity, entry.unitPrice))}:total:`,
      );
    }
    return parts.join(' · ');
  });
  protected readonly variantRow = computed(() => {
    const id = this.lastAdded();
    const row = id ? this.rows().find((candidate) => candidate.product.id === id) : null;
    return row && variantsOf(row.product.name).length > 0 ? row : null;
  });
  protected readonly sheetItem = computed<MarketRow | null>(() => {
    const open = this.open();
    const row = open
      ? this.rows().find((candidate) => candidate.product.id === open.productId)
      : null;
    return row ?? null;
  });
  protected readonly sheetPrice = computed(() => this.open()?.price ?? false);

  protected money(value: number | null | undefined): string {
    return formatMoney(value ?? 0);
  }

  protected label(key: CategoryKey): string {
    return categoryLabel(key);
  }

  protected sub(row: MarketRow): string {
    const parts: string[] = [];
    if (row.quantity !== 1 || row.product.unit) {
      parts.push(formatQuantity(row.quantity, row.product.unit));
    }
    if (row.promoNote) parts.push(row.promoNote);
    const last = this.lastPrices().get(row.product.id);
    if (last !== undefined && row.unitPrice === null) {
      parts.push($localize`:@@shopping.last-price-short:antes ${formatMoney(last)}:price:`);
    }
    return parts.join(' · ');
  }

  protected variants(row: MarketRow): readonly string[] {
    return variantsOf(row.product.name);
  }

  protected budgetField(): string {
    return moneyField(this.purchase()?.budget);
  }

  protected async start(fromList: boolean): Promise<void> {
    await this.actions.startPurchase(fromList);
  }

  protected async add(text = this.draft()): Promise<void> {
    const entry = parseEntry(text, this.actions.entryCategory);
    this.draft.set('');
    if (!entry) return;
    const product = await this.actions.quickAdd(entry);
    this.lastAdded.set(product?.id ?? null);
  }

  /** A sugestão completa o nome e deixa o campo pronto para o preço. */
  protected suggest(name: string, input: HTMLInputElement): void {
    this.draft.set(`${name} `);
    input.value = `${name} `;
    input.focus();
  }

  protected toggle(row: MarketRow): Promise<void> {
    return this.actions.toggle(row);
  }

  protected async variant(row: MarketRow, option: string): Promise<void> {
    this.lastAdded.set(null);
    await this.actions.marketVariant(row, option);
  }

  protected async saveBudget(input: HTMLInputElement): Promise<void> {
    const value = parseMoney(input.value);
    if (value === null) {
      this.notice.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      return;
    }
    this.notice.set(null);
    this.editingBudget.set(false);
    await this.actions.saveBudget(value ?? null);
  }

  protected useAsBudget(value: number): Promise<void> {
    return this.actions.saveBudget(Math.floor(value * 100) / 100);
  }

  protected async category(key: CategoryKey): Promise<void> {
    const item = this.sheetItem();
    if (item) await this.actions.setCategory(item.product, key);
  }

  protected async sheetVariant(option: string): Promise<void> {
    const row = this.sheetItem();
    if (row) await this.variant(row, option);
  }

  protected async saved(result: SheetResult): Promise<void> {
    const row = this.sheetItem();
    if (!row) return;
    if (result.quantity !== row.quantity) await this.actions.setQuantity(row, result.quantity);
    if (result.price) await this.actions.price(row, result.price);
  }

  protected async removed(): Promise<void> {
    const row = this.sheetItem();
    if (row) await this.actions.removeLine(row);
  }

  protected async finish(paid: HTMLInputElement, place: HTMLInputElement): Promise<void> {
    // Sem valor digitado, vale o total que a tela somou.
    const value = paid.value.trim() === '' ? this.total() : parseMoney(paid.value);
    if (value === null || value === undefined) {
      this.notice.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      return;
    }
    this.notice.set(null);
    await this.actions.finish(value, place.value.trim() || null);
    await this.router.navigateByUrl('/compras/historico');
  }
}
