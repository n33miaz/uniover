import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ShoppingActions } from './shopping-actions';
import { categoryLabel, variantsOf, type CategoryKey } from './shopping-categories';
import { parseEntry } from './shopping-entry';
import { formatQuantity } from './shopping-format';
import { ShoppingItemIcon } from './shopping-item-icon';
import { ShoppingOpening } from './shopping-opening';
import { ShoppingItemSheet, type SheetItem, type SheetResult } from './shopping-item-sheet';
import { listSections, type ListRow } from './shopping-model';
import { suggestNames } from './shopping-suggest';

/**
 * A lista para comprar depois. Um campo embaixo (com sugestões do que o grupo já comprou e de nomes comuns) põe o item na
 * hora; "2 leite" ou "leite 2x" já leva a quantidade. A lista sai agrupada por corredor. Tocar no item abre a folha
 * (quantidade, categoria, tipo); "Já tenho" tira da lista. Há uma lista por grupo: é ela que o Mercado Agora usa.
 */
@Component({
  selector: 'app-shopping-list-page',
  imports: [RouterLink, ShoppingItemIcon, ShoppingItemSheet, ShoppingOpening],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-list.page.css'],
  templateUrl: './shopping-list.page.html',
})
export class ShoppingListPage {
  protected readonly actions = inject(ShoppingActions);
  protected readonly draft = signal('');
  /** O último item posto, enquanto ele tem tipos a sugerir ("leite" → integral, desnatado...). */
  protected readonly lastAdded = signal<string | null>(null);
  protected readonly open = signal<ListRow | null>(null);

  protected readonly sections = computed(() => listSections(this.actions.snapshot()));
  protected readonly count = computed(() =>
    this.sections().reduce((sum, section) => sum + section.rows.length, 0),
  );
  protected readonly suggestions = computed(() =>
    suggestNames(this.actions.snapshot(), this.draft()),
  );
  /** A linha do último item, se ele ainda está na lista e é genérico. */
  protected readonly variantRow = computed(() => {
    const id = this.lastAdded();
    if (!id) return null;
    const row = this.sections()
      .flatMap((section) => section.rows)
      .find((candidate) => candidate.product.id === id);
    return row && variantsOf(row.product.name).length > 0 ? row : null;
  });
  protected readonly sheetItem = computed<SheetItem | null>(() => {
    const row = this.open();
    if (!row) return null;
    // A folha acompanha o produto (a categoria muda na hora).
    const product = this.actions.snapshot().products.get(row.product.id) ?? row.product;
    return { product, quantity: row.item.quantity };
  });

  protected label(key: CategoryKey): string {
    return categoryLabel(key);
  }

  protected quantity(row: ListRow): string | null {
    return row.item.quantity !== 1 || row.product.unit
      ? formatQuantity(row.item.quantity, row.product.unit)
      : null;
  }

  protected variants(row: ListRow): readonly string[] {
    return variantsOf(row.product.name);
  }

  protected async add(text = this.draft()): Promise<void> {
    const entry = parseEntry(text, this.actions.entryCategory);
    this.draft.set('');
    if (!entry) return;
    const product = await this.actions.addToList(entry.name, entry.quantity);
    this.lastAdded.set(product?.id ?? null);
  }

  protected async variant(row: ListRow, variant: string): Promise<void> {
    this.lastAdded.set(null);
    await this.actions.listVariant(row, variant);
  }

  protected async drop(row: ListRow): Promise<void> {
    if (this.lastAdded() === row.product.id) this.lastAdded.set(null);
    await this.actions.dropFromList(row);
  }

  protected async category(key: CategoryKey): Promise<void> {
    const item = this.sheetItem();
    if (item) await this.actions.setCategory(item.product, key);
  }

  protected async sheetVariant(variant: string): Promise<void> {
    const row = this.open();
    if (row) await this.variant(row, variant);
  }

  protected async saved(result: SheetResult): Promise<void> {
    const row = this.open();
    if (row) await this.actions.setListQuantity(row, result.quantity);
  }

  protected async removed(): Promise<void> {
    const row = this.open();
    if (row) await this.drop(row);
  }
}
