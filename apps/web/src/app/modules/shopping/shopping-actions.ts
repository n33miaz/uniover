import { Injectable, computed, inject } from '@angular/core';
import { uuidV7 } from '../../core/offline-queue/uuid-v7';
import { categorize, categoryOf, withVariant, type CategoryKey } from './shopping-categories';
import type { ParsedEntry } from './shopping-entry';
import {
  emptySnapshot,
  findProduct,
  marketRows,
  openPurchase,
  type ListRow,
  type MarketRow,
  type Product,
} from './shopping-model';
import { ShoppingSession } from './shopping-session';

/** O texto da promoção marcada só com a palavra "promo" no campo do mercado. */
export const PROMO_NOTE = $localize`:@@shopping.promo.note:promoção`;

/** O que muda no preço de uma linha: o preço pago por unidade e, na promoção, o da etiqueta e o texto. */
export interface PriceChange {
  readonly unitPrice: number | null;
  readonly regularPrice?: number | null;
  readonly promoNote?: string | null;
}

/**
 * As escritas das telas de Compras, num lugar só. Toda escrita vai para a fila do aparelho (`ShoppingStore.enqueue`):
 * aparece na hora, com ou sem sinal. As mudanças numa linha da compra saem uma por vez, cada uma partindo do que a
 * anterior deixou (ver `putLine`).
 */
@Injectable()
export class ShoppingActions {
  private readonly session = inject(ShoppingSession);
  private lineWrites: Promise<void> = Promise.resolve();

  readonly store = this.session.store;
  readonly snapshot = computed(() => this.store()?.snapshot() ?? emptySnapshot());
  readonly purchase = computed(() => openPurchase(this.snapshot()));
  readonly rows = computed(() => {
    const purchase = this.purchase();
    return purchase ? marketRows(this.snapshot(), purchase) : [];
  });

  /** O produto com esse nome (sem acento nem caixa), criado se ainda não existe, já com a categoria do nome. */
  async ensureProduct(name: string, unit: string | null = null): Promise<Product | null> {
    const store = this.store();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!store || !clean) return null;
    const found = findProduct(this.snapshot(), clean);
    if (found) return found;
    const id = uuidV7();
    await store.enqueue('product', id, { name: clean, section: categorize(clean), unit });
    return this.snapshot().products.get(id) ?? null;
  }

  /** A categoria de um nome digitado: a do produto que já existe com ele (escolhida pela pessoa) ou a da tabela. */
  readonly entryCategory = (name: string): CategoryKey => {
    const found = findProduct(this.snapshot(), name);
    return found ? categoryOf(found) : categorize(name);
  };

  /** A categoria escolhida pela pessoa (um toque); o resto do produto fica como está. */
  async setCategory(product: Product, category: CategoryKey): Promise<void> {
    await this.store()?.enqueue('product', product.id, {
      name: product.name,
      section: category,
      unit: product.unit ?? null,
    });
  }

  // ---- Lista ----

  /** Põe na lista: reaproveita o produto e o item que já existem, para não duplicar nenhum dos dois. */
  async addToList(name: string, quantity = 1): Promise<Product | null> {
    const store = this.store();
    const product = await this.ensureProduct(name);
    if (!store || !product) return null;
    const item = [...this.snapshot().listItems.values()].find(
      (candidate) => candidate.productId === product.id && !candidate.deleted,
    );
    if (item?.needed && quantity === item.quantity) return product;
    // Voltar à lista com quantidade 1 só liga o "precisa": a quantidade de antes fica (como sempre foi).
    const onlyNeeded = quantity === 1 && !item?.needed;
    await store.enqueue('listItem', item?.id ?? uuidV7(), {
      productId: product.id,
      quantity,
      note: item?.note ?? null,
      needed: true,
      ...(onlyNeeded ? { only: 'needed' } : {}),
    });
    return product;
  }

  /** Já tem em casa (ou comprou): sai da lista e continua conhecido para a próxima vez. */
  async dropFromList(row: ListRow): Promise<void> {
    await this.store()?.enqueue('listItem', row.item.id, {
      productId: row.item.productId,
      quantity: row.item.quantity,
      note: row.item.note ?? null,
      needed: false,
      only: 'needed',
    });
  }

  async setListQuantity(row: ListRow, quantity: number): Promise<void> {
    if (!(quantity > 0) || quantity === row.item.quantity) return;
    await this.store()?.enqueue('listItem', row.item.id, {
      productId: row.item.productId,
      quantity,
      note: row.item.note ?? null,
      needed: true,
    });
  }

  /** O tipo escolhido para um nome genérico: o item passa a ser "Leite integral", com a mesma quantidade. */
  async listVariant(row: ListRow, variant: string): Promise<void> {
    const quantity = row.item.quantity;
    await this.dropFromList(row);
    await this.addToList(withVariant(row.product.name, variant), quantity);
  }

  // ---- Mercado ----

  /** Começa a compra: da lista (o que "precisa" vira linha) ou do zero. Com uma aberta, nada muda. */
  async startPurchase(fromList: boolean): Promise<void> {
    const store = this.store();
    if (!store || this.purchase()) return;
    await store.enqueue('openPurchase', uuidV7(), { fromList });
  }

  /** O que foi digitado no campo do mercado: o item entra pego, com quantidade e preço. */
  async quickAdd(entry: ParsedEntry): Promise<Product | null> {
    const product = await this.ensureProduct(entry.name, entry.unit);
    if (!product) return null;
    // Num item que já estava na compra (veio da lista), o que não foi digitado fica como estava.
    await this.putLine(product.id, (now) => ({
      picked: true,
      quantity: entry.quantity !== 1 ? entry.quantity : now.quantity,
      unitPrice: entry.unitPrice ?? now.unitPrice,
      regularPrice: entry.unitPrice === null ? now.regularPrice : null,
      promoNote:
        entry.promo && (entry.unitPrice ?? now.unitPrice) !== null
          ? PROMO_NOTE
          : entry.unitPrice === null
            ? now.promoNote
            : null,
    }));
    return product;
  }

  /** Um toque = peguei (outro toque desfaz). O preço não muda. */
  toggle(row: MarketRow): Promise<void> {
    return this.putLine(row.product.id, (now) => ({ ...now, picked: !now.picked }));
  }

  /** O preço (opcional) e a promoção. O preço não marca nada: "peguei" é um toque à parte. */
  price(row: MarketRow, change: PriceChange): Promise<void> {
    return this.putLine(row.product.id, (now) => {
      const next = {
        ...now,
        unitPrice: change.unitPrice,
        regularPrice: change.unitPrice === null ? null : (change.regularPrice ?? null),
        promoNote: change.unitPrice === null ? null : change.promoNote?.trim() || null,
      };
      return next.unitPrice === now.unitPrice &&
        next.regularPrice === now.regularPrice &&
        next.promoNote === now.promoNote
        ? null
        : next;
    });
  }

  setQuantity(row: MarketRow, quantity: number): Promise<void> {
    if (!(quantity > 0)) return Promise.resolve();
    return this.putLine(row.product.id, (now) =>
      now.quantity === quantity ? null : { ...now, quantity },
    );
  }

  /** Tira o item da compra. */
  async removeLine(row: MarketRow): Promise<void> {
    await this.lineWrites;
    const purchase = this.purchase();
    if (!purchase) return;
    if (!row.lineId) {
      // Ainda sem linha: o item só está aqui por estar na lista. Tirar é tirá-lo da lista.
      const item = [...this.snapshot().listItems.values()].find(
        (candidate) => candidate.productId === row.product.id && !candidate.deleted,
      );
      if (item) await this.dropFromList({ item, product: row.product });
      return;
    }
    await this.store()?.enqueue(
      'purchaseItem',
      row.lineId,
      { productId: row.product.id, quantity: row.quantity, picked: false, deleted: true },
      purchase.id,
    );
  }

  /** O tipo escolhido no mercado: a linha passa para o produto detalhado, com quantidade, preço e "peguei". */
  async marketVariant(row: MarketRow, variant: string): Promise<void> {
    const product = await this.ensureProduct(
      withVariant(row.product.name, variant),
      row.product.unit ?? null,
    );
    if (!product || product.id === row.product.id) return;
    await this.removeLine(row);
    await this.putLine(product.id, () => ({
      picked: row.picked,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      regularPrice: row.regularPrice,
      promoNote: row.promoNote,
    }));
  }

  /**
   * Grava uma mudança na linha de um produto. As mudanças saem uma por vez e cada uma parte do que a anterior deixou:
   * quem digita o preço e toca em "peguei" logo em seguida dispara as duas quase juntas, e a segunda não pode partir da
   * linha como a tela a desenhou antes da primeira (o preço se perderia, ou o produto ganharia duas linhas). O servidor
   * fica sabendo só o que mudou (`only`): o toque em "peguei" não leva junto o preço que este aparelho tinha.
   */
  private putLine(productId: string, change: (now: LineState) => LineState | null): Promise<void> {
    const write = this.lineWrites.then(async () => {
      const purchase = this.purchase();
      if (!purchase) return;
      const row = this.rows().find((candidate) => candidate.product.id === productId);
      const now: LineState = row
        ? {
            picked: row.picked,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            regularPrice: row.regularPrice,
            promoNote: row.promoNote,
          }
        : { picked: false, quantity: 1, unitPrice: null, regularPrice: null, promoNote: null };
      const wanted = change(now);
      if (!wanted) return;
      const priceChanged =
        wanted.unitPrice !== now.unitPrice ||
        wanted.regularPrice !== now.regularPrice ||
        wanted.promoNote !== now.promoNote;
      const only =
        !row?.lineId || wanted.quantity !== now.quantity
          ? {}
          : !priceChanged
            ? { only: 'picked' }
            : wanted.picked === now.picked
              ? { only: 'price' }
              : {};
      await this.store()?.enqueue(
        'purchaseItem',
        row?.lineId ?? uuidV7(),
        { productId, ...wanted, ...only },
        purchase.id,
      );
    });
    this.lineWrites = write.catch(() => undefined);
    return write;
  }

  /** Espera as escritas de linha em curso (o fechamento vai depois delas). */
  settledLines(): Promise<void> {
    return this.lineWrites;
  }

  async saveBudget(budget: number | null): Promise<void> {
    const purchase = this.purchase();
    if (!purchase || budget === (purchase.budget ?? null)) return;
    await this.store()?.enqueue('budget', purchase.id, { budget });
  }

  /** Fecha a compra depois das escritas de linha em curso: fechar antes faria o servidor recusar o que vinha atrás. */
  async finish(totalPaid: number, store: string | null): Promise<void> {
    await this.lineWrites;
    const purchase = this.purchase();
    if (!purchase) return;
    await this.store()?.enqueue('closePurchase', purchase.id, { totalPaid, store });
  }
}

interface LineState {
  readonly picked: boolean;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly regularPrice: number | null;
  readonly promoNote: string | null;
}
