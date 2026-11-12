import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import type { PriceChange } from './shopping-actions';
import {
  CATEGORY_KEYS,
  categoryLabel,
  categoryOf,
  variantsOf,
  type CategoryKey,
} from './shopping-categories';
import { categoryDrawing, ShoppingItemIcon } from './shopping-item-icon';
import { takePayPrice } from './shopping-entry';
import { formatMoney, moneyField } from './shopping-format';
import { parseMoney, type Product } from './shopping-model';

/** O item aberto na folha: o produto e o que a linha (da lista ou da compra) tem agora. */
export interface SheetItem {
  readonly product: Product;
  readonly quantity: number;
  readonly unitPrice?: number | null;
  readonly regularPrice?: number | null;
  readonly promoNote?: string | null;
}

export interface SheetResult {
  readonly quantity: number;
  /** Só no mercado. */
  readonly price?: PriceChange;
}

type PromoKind = 'off' | 'lower' | '3x2' | '2x1';

const TAKE_PAY: Record<'3x2' | '2x1', { take: number; pay: number; note: string }> = {
  '3x2': { take: 3, pay: 2, note: $localize`:@@shopping.promo.3x2:leve 3 pague 2` },
  '2x1': { take: 2, pay: 1, note: $localize`:@@shopping.promo.2x1:leve 2 pague 1` },
};

/**
 * A folha de um item: categoria e tipo com um toque, quantidade e, no mercado, o preço com a promoção. Tudo opcional:
 * fechar sem mexer não muda nada. O preço da promoção "leve 3 pague 2" é calculado aqui (o que sai por unidade), e o
 * preço da etiqueta fica guardado como o normal.
 */
@Component({
  selector: 'app-shopping-item-sheet',
  imports: [ShoppingItemIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-item-sheet.css'],
  templateUrl: './shopping-item-sheet.html',
})
export class ShoppingItemSheet {
  readonly item = input<SheetItem | null>(null);
  readonly mode = input<'list' | 'market'>('list');
  /** A pessoa escolheu outra categoria (vale na hora). */
  readonly category = output<CategoryKey>();
  /** A pessoa escolheu um tipo ("integral"): o item passa a ser outro, e a folha fecha. */
  readonly variant = output<string>();
  readonly saved = output<SheetResult>();
  readonly removed = output<void>();
  readonly closed = output<void>();

  private readonly injector = inject(Injector);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly priceInput = viewChild<ElementRef<HTMLInputElement>>('priceField');

  protected readonly categories = CATEGORY_KEYS;
  /** Símbolo da unidade (não se traduz). */
  protected readonly kg = 'kg';
  protected readonly quantity = signal('1');
  protected readonly price = signal('');
  protected readonly regular = signal('');
  protected readonly promo = signal<PromoKind>('off');
  protected readonly error = signal<string | null>(null);
  /** Abrir já com o cursor no preço (o toque veio do preço da linha). */
  readonly focusPrice = input(false);

  protected readonly current = computed(() => {
    const item = this.item();
    return item ? categoryOf(item.product) : null;
  });
  protected readonly variants = computed(() => {
    const item = this.item();
    return item ? variantsOf(item.product.name) : [];
  });
  protected readonly isKg = computed(() => this.item()?.product.unit === 'kg');
  /** O que sai por unidade na promoção "leve N pague M", para a pessoa conferir. */
  protected readonly takePay = computed(() => {
    const kind = this.promo();
    if (kind !== '3x2' && kind !== '2x1') return null;
    const sticker = parseMoney(this.price());
    if (sticker === null || sticker === undefined) return null;
    const rule = TAKE_PAY[kind];
    const each = takePayPrice(sticker, rule.take, rule.pay);
    return each === null ? null : formatMoney(each);
  });

  constructor() {
    // Cada item que abre recomeça os campos com o que a linha tem.
    effect(() => {
      const item = this.item();
      untracked(() => {
        if (!item) return;
        this.reset(item);
        this.open();
      });
    });
  }

  protected label(key: CategoryKey): string {
    return categoryLabel(key);
  }

  protected drawing(key: CategoryKey): string {
    return categoryDrawing(key);
  }

  protected step(delta: number): void {
    const now = this.readQuantity() ?? 1;
    const step = this.isKg() ? 0.1 * delta : delta;
    const next = Math.round((now + step) * 1000) / 1000;
    if (next > 0) this.quantity.set(String(next).replace('.', ','));
  }

  protected save(): void {
    const quantity = this.readQuantity();
    if (quantity === null) {
      this.error.set(
        $localize`:@@shopping.sheet.quantity-error:Digite uma quantidade como 2 ou 1,5.`,
      );
      return;
    }
    if (this.mode() === 'list') {
      this.saved.emit({ quantity });
      this.close();
      return;
    }
    const price = this.readPrice();
    if (price === null) {
      this.error.set($localize`:@@shopping.notice.money:Digite um valor como 12,50.`);
      return;
    }
    if (price === 'regular-not-above') {
      this.error.set(
        $localize`:@@shopping.sheet.regular-error:O preço normal precisa ser maior que o de agora.`,
      );
      return;
    }
    this.saved.emit({ quantity, price });
    this.close();
  }

  protected remove(): void {
    this.removed.emit();
    this.close();
  }

  protected pickVariant(variant: string): void {
    this.variant.emit(variant);
    this.close();
  }

  protected close(): void {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog?.open) {
      this.closed.emit();
      return;
    }
    leaveDialog(dialog, () => {
      dialog.close();
      dialog.classList.remove('closing');
      this.closed.emit();
    });
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  private open(): void {
    afterNextRender(
      () => {
        const dialog = this.dialog()?.nativeElement;
        if (!dialog || dialog.open) return;
        dialog.showModal();
        if (!dialog.dataset['wired']) {
          dialog.dataset['wired'] = '1';
          onDialogBackdropClick(dialog, () => this.close());
        }
        if (this.focusPrice() && this.mode() === 'market') this.priceInput()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  private reset(item: SheetItem): void {
    this.error.set(null);
    this.quantity.set(String(item.quantity).replace('.', ','));
    const note = item.promoNote ?? null;
    const kind: PromoKind =
      note === TAKE_PAY['3x2'].note
        ? '3x2'
        : note === TAKE_PAY['2x1'].note
          ? '2x1'
          : item.regularPrice !== null && item.regularPrice !== undefined
            ? 'lower'
            : 'off';
    this.promo.set(kind);
    // Na "leve N pague M" o campo mostra o preço da etiqueta (o normal); a conta do que sai por unidade é refeita.
    this.price.set(
      moneyField(kind === '3x2' || kind === '2x1' ? item.regularPrice : item.unitPrice),
    );
    this.regular.set(kind === 'lower' ? moneyField(item.regularPrice) : '');
  }

  private readQuantity(): number | null {
    const text = this.quantity().trim().replace(',', '.');
    if (!/^\d+(\.\d{1,3})?$/.test(text)) return null;
    const value = Number(text);
    return value > 0 && value <= 999_999.999 ? value : null;
  }

  /**
   * O preço como vai para a linha; `null` quando algum campo não é dinheiro. O preço normal só vai acima do pago (o
   * servidor recusa o resto): na "leve N pague M" que não baixa nada (etiqueta zero), vai só o preço.
   */
  private readPrice(): PriceChange | 'regular-not-above' | null {
    const typed = parseMoney(this.price());
    if (typed === null) return null;
    const kind = this.promo();
    if (typed === undefined) return { unitPrice: null };
    if (kind === '3x2' || kind === '2x1') {
      const rule = TAKE_PAY[kind];
      const each = takePayPrice(typed, rule.take, rule.pay);
      if (each === null || each >= typed) return { unitPrice: typed };
      return {
        unitPrice: each,
        regularPrice: typed,
        promoNote: rule.note,
      };
    }
    if (kind === 'lower') {
      const regular = parseMoney(this.regular());
      if (regular === null) return null;
      if (regular !== undefined && regular <= typed) return 'regular-not-above';
      return {
        unitPrice: typed,
        regularPrice: regular ?? null,
        promoNote: $localize`:@@shopping.promo.lower:preço de promoção`,
      };
    }
    return { unitPrice: typed };
  }
}
