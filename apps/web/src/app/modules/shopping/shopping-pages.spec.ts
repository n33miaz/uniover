import { signal, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SessionState } from '../../core/session/session-state';
import { ShoppingActions } from './shopping-actions';
import { ShoppingEconomizeApi } from './shopping-economize-api';
import { ShoppingHistoryPage } from './shopping-history.page';
import { ShoppingHubPage } from './shopping-hub.page';
import { ShoppingListPage } from './shopping-list.page';
import { ShoppingMarketPage } from './shopping-market.page';
import { marketRows, openPurchase } from './shopping-model';
import { ShoppingSession } from './shopping-session';
import type { ShoppingStore } from './shopping-store';
import { storeBench, type StoreBench } from './shopping-test-kit';

describe('Compras: the screens', () => {
  let bench: StoreBench;
  let store: ShoppingStore;
  let el: HTMLElement;
  let fixture: ComponentFixture<unknown>;

  beforeEach(async () => {
    bench = storeBench();
    store = await bench.open();
    for (const [key, name, quantity] of [
      ['milk', 'Leite', 2],
      ['bread', 'Pão', 1],
    ] as const) {
      await store.enqueue('product', key, { name });
      await store.enqueue('listItem', `li-${key}`, { productId: key, quantity, needed: true });
    }
    await store.settled();
  });

  afterEach(() => bench.close());

  async function mount<T>(component: Type<T>): Promise<T> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        ShoppingActions,
        { provide: ShoppingSession, useValue: { store: signal(store) } },
        { provide: SessionState, useValue: { role: signal('guest') } },
        {
          provide: ShoppingEconomizeApi,
          useValue: { advice: async () => ({ available: false, reason: 'disabled' }) },
        },
      ],
    });
    const created = TestBed.createComponent(component);
    fixture = created as ComponentFixture<unknown>;
    el = created.nativeElement as HTMLElement;
    await settle();
    return created.componentInstance;
  }

  /** As escritas passam pelo IndexedDB (tarefas, não microtarefas): espera algumas voltas até tudo assentar. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await store.settled();
      await fixture.whenStable();
      fixture.detectChanges();
    }
  }

  const text = (): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  const button = (label: string): HTMLButtonElement => {
    const found = Array.from(el.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    );
    if (!found) throw new Error(`sem botão "${label}"`);
    return found;
  };

  async function type(selector: string, value: string): Promise<void> {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function submit(selector: string): Promise<void> {
    el.querySelector<HTMLFormElement>(selector)!.dispatchEvent(new Event('submit'));
    await settle();
  }

  describe('the entry', () => {
    it('offers the list, the market and, smaller, the history and the details', async () => {
      await mount(ShoppingHubPage);
      const links = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(links).toEqual(['/lista', '/mercado', '/historico', '/detalhes']);
      expect(text()).toContain('2 para comprar');
      expect(text()).toContain('Com a lista ou do zero');
      expect(text()).toContain('Nenhuma compra ainda');
    });
  });

  describe('the list', () => {
    it('groups by aisle, adds with a quantity in one go, and drops what is at home', async () => {
      await mount(ShoppingListPage);
      const labels = (): string[] =>
        Array.from(el.querySelectorAll('h2')).map((h) => h.textContent!.trim());
      expect(labels()).toEqual(['Padaria', 'Laticínios e frios']);

      await type('input[name="product"]', '3 bananas');
      await submit('form.ui-action-bar');
      expect(labels()).toEqual(['Hortifrúti', 'Padaria', 'Laticínios e frios']);
      expect(text()).toContain('Bananas');
      const banana = [...store.snapshot().products.values()].find((p) => p.name === 'Bananas')!;
      expect(banana.section).toBe('hortifruti');
      expect(
        [...store.snapshot().listItems.values()].find((i) => i.productId === banana.id)?.quantity,
      ).toBe(3);

      // O primeiro "Já tenho" é o das bananas (o hortifrúti vem primeiro).
      button('Já tenho').click();
      await settle();
      expect(labels()).toEqual(['Padaria', 'Laticínios e frios']);
    });

    it('suggests what the group bought and common names while typing', async () => {
      await mount(ShoppingListPage);
      await type('input[name="product"]', 'lei');
      const chips = Array.from(el.querySelectorAll('.chips .chip')).map((c) =>
        c.textContent!.trim(),
      );
      expect(chips[0]).toBe('Leite');
      expect(chips).toContain('Leite condensado');
    });

    it('asks the kind of a generic item, one tap to choose or to skip', async () => {
      await mount(ShoppingListPage);
      await type('input[name="product"]', 'café');
      await submit('form.ui-action-bar');
      expect(text()).toContain('Café:');

      button('extraforte').click();
      await settle();
      expect(text()).toContain('Café extraforte');
      expect(text()).not.toContain('Café:');
    });
  });

  describe('the market', () => {
    it('asks first: the list or from scratch', async () => {
      await mount(ShoppingMarketPage);
      expect(text()).toContain('Usar a lista');
      expect(text()).toContain('2 itens para pegar');

      button('Começar do zero').click();
      await settle();
      const purchase = openPurchase(store.snapshot())!;
      expect(purchase.fromList).toBe(false);
      expect(marketRows(store.snapshot(), purchase)).toEqual([]);
      expect(text()).toContain('Digite embaixo o que pegar');
    });

    it('one field puts item, quantity and price, already picked, and the total follows', async () => {
      await mount(ShoppingMarketPage);
      button('Usar a lista').click();
      await settle();

      await type('input[name="entry"]', 'arroz 2x 12,90');
      expect(el.querySelector('.preview')?.textContent).toContain('Arroz · 2 · R$');
      await submit('form.ui-action-bar');

      const purchase = openPurchase(store.snapshot())!;
      const rice = marketRows(store.snapshot(), purchase).find((r) => r.product.name === 'Arroz')!;
      expect(rice).toMatchObject({ quantity: 2, unitPrice: 12.9, picked: true });
      expect(el.querySelector('.total strong')?.textContent).toContain('25,80');
      expect(text()).toContain('No carrinho');
    });

    it('typing an item that came from the list picks it, keeping the list quantity', async () => {
      await mount(ShoppingMarketPage);
      button('Usar a lista').click();
      await settle();

      await type('input[name="entry"]', 'leite 5,49');
      await submit('form.ui-action-bar');

      const purchase = openPurchase(store.snapshot())!;
      const milk = marketRows(store.snapshot(), purchase).filter((r) => r.product.name === 'Leite');
      expect(milk).toHaveLength(1);
      expect(milk[0]).toMatchObject({ quantity: 2, unitPrice: 5.49, picked: true });
    });

    it('a tap on the item picks it; the price opens the sheet with the promotion', async () => {
      await mount(ShoppingMarketPage);
      button('Usar a lista').click();
      await settle();

      el.querySelector<HTMLButtonElement>('button.pick')!.click();
      await settle();
      expect(el.querySelectorAll('.cart li')).toHaveLength(1);

      el.querySelector<HTMLButtonElement>('button.price')!.click();
      await settle();
      const dialog = el.querySelector('dialog')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      await type('#shopping-sheet-price', '4,99');
      Array.from(dialog.querySelectorAll('button'))
        .find((b) => b.textContent!.includes('Leve 3 pague 2'))!
        .click();
      fixture.detectChanges();
      expect(dialog.textContent).toContain('Sai R$');
      await submit('dialog form');

      const purchase = openPurchase(store.snapshot())!;
      const row = marketRows(store.snapshot(), purchase).find((r) => r.unitPrice !== null)!;
      expect(row).toMatchObject({
        unitPrice: 3.33,
        regularPrice: 4.99,
        promoNote: 'leve 3 pague 2',
      });
    });

    it('closes the purchase with the total and goes to the history', async () => {
      await mount(ShoppingMarketPage);
      button('Usar a lista').click();
      await settle();
      await type('input[name="entry"]', 'leite 5,49');
      await submit('form.ui-action-bar');

      button('Terminei').click();
      await settle();
      await type('#shopping-store', 'Mercado da Esquina');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      await submit('form.finish');

      expect(openPurchase(store.snapshot())).toBeUndefined();
      expect(navigate).toHaveBeenCalledWith('/compras/historico');
    });
  });

  describe('the history', () => {
    it('lists the closed purchases compactly and opens one on a tap', async () => {
      await store.enqueue('openPurchase', 'p1', {});
      await store.settled();
      const line = [...store.snapshot().purchaseItems.values()].find(
        (l) => l.productId === 'milk',
      )!;
      await store.enqueue(
        'purchaseItem',
        line.id,
        { productId: 'milk', quantity: 2, unitPrice: 5, picked: true },
        'p1',
      );
      await store.enqueue('closePurchase', 'p1', { totalPaid: 10, store: 'Mercado' });
      await store.settled();

      await mount(ShoppingHistoryPage);
      expect(text()).toContain('Mercado');
      expect(text()).toContain('R$ 10,00');
      expect(text()).not.toContain('Leite');

      el.querySelector<HTMLButtonElement>('button.trip')!.click();
      await settle();
      expect(text()).toContain('Leite');
      expect(text()).toContain('2 × R$ 5,00');
    });
  });
});
