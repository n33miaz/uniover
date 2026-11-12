import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { uuidV7 } from '../../core/offline-queue/uuid-v7';
import {
  budgetState,
  closedPurchases,
  emptySnapshot,
  findProduct,
  listSections,
  marketRows,
  openPurchase,
  parseMoney,
  pickedTotal,
  suggestProducts,
  type ListRow,
  type MarketRow,
  type Product,
  type Purchase,
} from './shopping-model';
import { ShoppingPeople } from './shopping-people';
import { ShoppingSession } from './shopping-session';

type View = 'list' | 'market' | 'history' | 'people';

const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DAY = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Compras: a lista da casa, o modo mercado (um toque = peguei, preço opcional e à parte, total e teto no topo) e as compras
 * anteriores. A tela lê e grava só no aparelho (`ShoppingStore`); o envio e o feed correm por trás.
 */
@Component({
  selector: 'app-shopping-page',
  imports: [ShoppingPeople],
  templateUrl: './shopping.page.html',
  styleUrl: './shopping.page.css',
  providers: [ShoppingSession],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShoppingPage {
  private readonly session = inject(ShoppingSession);

  protected readonly store = this.session.store;
  protected readonly view = signal<View>('list');
  protected readonly draft = signal('');
  /** O recado de um campo que não deu para aceitar (valor que não é dinheiro). */
  protected readonly notice = signal<string | null>(null);
  protected readonly editingBudget = signal(false);
  protected readonly priceLabel = $localize`:@@shopping.price:Preço de`;
  private lineWrites: Promise<void> = Promise.resolve();

  protected readonly snapshot = computed(() => this.store()?.snapshot() ?? emptySnapshot());
  protected readonly syncState = computed(() => this.store()?.state() ?? 'synced');
  protected readonly pendingCount = computed(() => this.store()?.pendingCount() ?? 0);
  protected readonly sections = computed(() => listSections(this.snapshot()));
  protected readonly suggestions = computed(() => suggestProducts(this.snapshot(), this.draft()));
  protected readonly purchase = computed(() => openPurchase(this.snapshot()));
  protected readonly rows = computed(() => {
    const purchase = this.purchase();
    return purchase ? marketRows(this.snapshot(), purchase) : [];
  });
  /** A compra foi aberta sem sinal e ainda não chegou ao servidor (dá para marcar; o envio sai quando o sinal voltar). */
  protected readonly waiting = computed(() => {
    const purchase = this.purchase();
    return !!purchase && this.store()?.unconfirmedPurchase() === purchase.id;
  });
  protected readonly total = computed(() => pickedTotal(this.rows()));
  protected readonly budget = computed(() => budgetState(this.total(), this.purchase()?.budget));
  protected readonly history = computed(() => closedPurchases(this.snapshot()));
  protected readonly lastPrices = computed(() => this.store()?.lastPrices() ?? new Map());
  /** O recado do último envio: uma mudança que o servidor não aceitou nunca some calada. */
  protected readonly syncNotice = computed(() => {
    switch (this.store()?.notice()) {
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

  protected money(value: number | null | undefined): string {
    return MONEY.format(value ?? 0);
  }

  protected day(purchase: Purchase): string {
    return purchase.closedAt ? DAY.format(new Date(purchase.closedAt)) : '';
  }

  protected quantity(value: number, product: Product): string {
    const amount = String(value).replace('.', ',');
    return product.unit ? `${amount} ${product.unit}` : amount;
  }

  protected retry(): void {
    void this.store()?.sync();
  }

  protected dismiss(): void {
    this.store()?.notice.set(null);
  }

  protected show(view: View): void {
    this.notice.set(null);
    this.view.set(view);
  }

  /** Põe na lista o que foi digitado: reaproveita o produto e o item que já existem, para não duplicar nenhum dos dois. */
  protected async add(name = this.draft()): Promise<void> {
    const store = this.store();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!store || !clean) return;
    this.draft.set('');

    const snapshot = this.snapshot();
    const product = findProduct(snapshot, clean);
    const productId = product?.id ?? uuidV7();
    if (!product) await store.enqueue('product', productId, { name: clean });

    const item = [...snapshot.listItems.values()].find(
      (candidate) => candidate.productId === productId && !candidate.deleted,
    );
    if (item?.needed) return;
    await store.enqueue('listItem', item?.id ?? uuidV7(), {
      productId,
      quantity: item?.quantity ?? 1,
      note: item?.note ?? null,
      needed: true,
      only: 'needed',
    });
  }

  /** Já tem em casa: o item deixa de estar marcado como "precisa" (e continua conhecido para a próxima vez). */
  protected async drop(row: ListRow): Promise<void> {
    await this.store()?.enqueue('listItem', row.item.id, {
      productId: row.item.productId,
      quantity: row.item.quantity,
      note: row.item.note ?? null,
      needed: false,
      only: 'needed',
    });
  }

  protected async start(): Promise<void> {
    const store = this.store();
    if (!store) return;
    if (!this.purchase()) await store.enqueue('openPurchase', uuidV7(), {});
    this.show('market');
  }

  /**
   * Um toque = peguei (outro toque desfaz). O preço que estiver digitado no campo vai junto: no Safari do iPhone o
   * toque num botão não tira o foco do campo, então o preço ainda não teria sido gravado.
   */
  protected async toggle(row: MarketRow, input?: HTMLInputElement): Promise<void> {
    const typed = input ? parseMoney(input.value) : null;
    await this.putLine(row.product.id, (now) => ({
      picked: !now.picked,
      unitPrice: typed === null ? now.unitPrice : (typed ?? null),
    }));
  }

  /** O preço é opcional: vazio tira o preço; um texto que não é dinheiro não é enviado. */
  protected async price(row: MarketRow, input: HTMLInputElement): Promise<void> {
    const value = parseMoney(input.value);
    if (value === null) {
      this.notice.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      input.value = row.unitPrice === null ? '' : String(row.unitPrice).replace('.', ',');
      return;
    }
    this.notice.set(null);
    const unitPrice = value ?? null;
    // O preço não marca nada: "peguei" é sempre um toque à parte.
    await this.putLine(row.product.id, (now) =>
      unitPrice === now.unitPrice ? null : { picked: now.picked, unitPrice },
    );
  }

  /**
   * Grava uma mudança na linha de um produto. As mudanças saem uma por vez, e cada uma parte do que a anterior deixou:
   * quem digita o preço e toca em "peguei" logo em seguida dispara as duas quase juntas, e a segunda não pode partir da
   * linha como a tela a desenhou antes da primeira (o preço se perderia, ou o produto ganharia duas linhas).
   */
  private putLine(
    productId: string,
    change: (now: MarketRow) => { picked: boolean; unitPrice: number | null } | null,
  ): Promise<void> {
    const write = this.lineWrites.then(async () => {
      const purchase = this.purchase();
      const now = this.rows().find((row) => row.product.id === productId);
      const wanted = purchase && now ? change(now) : null;
      if (!purchase || !now || !wanted) return;
      // O servidor fica sabendo o que a pessoa mudou, e só mexe nisso: o toque em "peguei" não leva junto o preço que
      // este aparelho tinha (outra pessoa pode ter digitado um mais novo), nem o preço leva o "peguei".
      const only =
        wanted.unitPrice === now.unitPrice
          ? { only: 'picked' }
          : wanted.picked === now.picked
            ? { only: 'price' }
            : {};
      await this.store()?.enqueue(
        'purchaseItem',
        now.lineId ?? uuidV7(),
        { productId, quantity: now.quantity, ...wanted, ...only },
        purchase.id,
      );
    });
    this.lineWrites = write.catch(() => undefined);
    return write;
  }

  protected async saveBudget(input: HTMLInputElement): Promise<void> {
    const purchase = this.purchase();
    const value = parseMoney(input.value);
    if (!purchase) return;
    if (value === null) {
      this.notice.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      return;
    }
    this.notice.set(null);
    this.editingBudget.set(false);
    if ((value ?? null) === (purchase.budget ?? null)) return;
    await this.store()?.enqueue('budget', purchase.id, { budget: value ?? null });
  }

  protected async finish(paid: HTMLInputElement, place: HTMLInputElement): Promise<void> {
    // O fechamento entra na fila depois das escritas de linha ainda em curso: fechar antes faria o servidor recusar o
    // preço ou o "peguei" que vinha logo atrás.
    await this.lineWrites;
    const purchase = this.purchase();
    if (!purchase) return;
    // Sem valor digitado, vale o total que a tela somou.
    const value = paid.value.trim() === '' ? this.total() : parseMoney(paid.value);
    if (value === null || value === undefined) {
      this.notice.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      return;
    }
    await this.store()?.enqueue('closePurchase', purchase.id, {
      totalPaid: value,
      store: place.value.trim() || null,
    });
    this.show('history');
  }
}
