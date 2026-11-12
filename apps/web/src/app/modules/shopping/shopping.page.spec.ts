import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ShoppingPeopleApi } from './shopping-people-api';
import { ShoppingSession } from './shopping-session';
import type { ShoppingStore } from './shopping-store';
import { storeBench, type StoreBench } from './shopping-test-kit';
import { ShoppingPage } from './shopping.page';

describe('ShoppingPage', () => {
  let bench: StoreBench;
  let store: ShoppingStore;
  let fixture: ComponentFixture<ShoppingPage>;
  let el: HTMLElement;

  beforeEach(async () => {
    bench = storeBench();
    store = await bench.open();
    for (const [key, name] of [
      ['milk', 'Leite'],
      ['bread', 'Pão'],
    ]) {
      await store.enqueue('product', key, { name });
      await store.enqueue('listItem', `li-${key}`, { productId: key, quantity: 1, needed: true });
    }
    await store.settled();

    TestBed.configureTestingModule({
      providers: [
        {
          provide: ShoppingPeopleApi,
          useValue: {
            group: async () => ({ id: 'group-1', isOwner: true }),
            people: async () => [{ userId: 'me', name: 'Neemias', isOwner: true, isMember: true }],
          },
        },
      ],
    });
    TestBed.overrideComponent(ShoppingPage, {
      set: { providers: [{ provide: ShoppingSession, useValue: { store: signal(store) } }] },
    });
    fixture = TestBed.createComponent(ShoppingPage);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => bench.close());

  async function settle(): Promise<void> {
    await store.settled();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(el.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.replace(/\s+/g, ' ').trim().startsWith(text),
    );
    if (!found) throw new Error(`sem botão "${text}"`);
    return found;
  };

  async function click(text: string): Promise<void> {
    button(text).click();
    // O toque grava no aparelho antes de aparecer: espera a gravação e o envio que ela dispara.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }

  const market = () =>
    Array.from(el.querySelectorAll('.market .ui-row')).map((row) => ({
      name: row.querySelector('.ui-row-title')?.textContent?.trim(),
      picked: row.querySelector('.pick')?.getAttribute('aria-pressed'),
      price: row.querySelector<HTMLInputElement>('input.price')?.value,
    }));

  async function typePrice(name: string, value: string): Promise<void> {
    const input = el.querySelector<HTMLInputElement>(`input[aria-label="Preço de ${name}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }

  const alerts = () =>
    Array.from(el.querySelectorAll('[role="alert"]')).map((alert) =>
      alert.textContent?.replace(/\s+/g, ' ').trim(),
    );

  it('typing a price does not mark the item as picked: picking is a tap of its own', async () => {
    await click('Ir ao mercado');
    await typePrice('Leite', '4,50');

    expect(market()).toContainEqual({ name: 'Leite', picked: 'false', price: '4.5' });
    expect(el.querySelector('.total strong')?.textContent).toContain('0,00');

    await click('Leite');

    expect(market()).toContainEqual({ name: 'Leite', picked: 'true', price: '4.5' });
    expect(el.querySelector('.total strong')?.textContent).toContain('4,50');
  });

  it('keeps the price when the tap on the item comes right after typing it', async () => {
    await click('Ir ao mercado');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Preço de Leite"]')!;
    input.value = '4,50';
    // O toque tira o foco do campo: o navegador entrega a mudança do preço e o toque um atrás do outro.
    input.dispatchEvent(new Event('change'));
    button('Leite').click();
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
    }

    expect(market()).toContainEqual({ name: 'Leite', picked: 'true', price: '4.5' });
    expect(market()).toHaveLength(2);
    expect(el.querySelector('.total strong')?.textContent).toContain('4,50');
    expect(bench.server.rowsOf('purchaseItem')).toHaveLength(2);
  });

  it('closes the purchase only after the price and the tap still on their way', async () => {
    await click('Ir ao mercado');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Preço de Leite"]')!;
    input.value = '4,50';
    input.dispatchEvent(new Event('change'));
    button('Leite').click();
    // Fechar logo em seguida, sem digitar o total: vale a soma, que precisa já contar o item marcado agora.
    el.querySelector<HTMLFormElement>('form.finish')!.dispatchEvent(new Event('submit'));
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
    }

    const closed = bench.server
      .rowsOf('purchase')
      .find((row) => row.payload['status'] === 'closed');
    expect(closed?.payload['totalPaid']).toBe(4.5);
    expect(alerts()).toEqual([]);
  });

  it('lets the person open the purchase and pick without signal, and sends it later', async () => {
    bench.online = false;
    await click('Ir ao mercado');

    expect(el.textContent).toContain('Guardado no aparelho');
    expect(button('Leite').disabled).toBe(false);
    await click('Leite');
    expect(market()).toContainEqual({ name: 'Leite', picked: 'true', price: '' });

    bench.online = true;
    await store.sync();
    await settle();

    expect(store.pendingCount()).toBe(0);
    expect(el.textContent).not.toContain('Guardado no aparelho');
    expect(market()).toContainEqual({ name: 'Leite', picked: 'true', price: '' });
    expect(bench.server.rowsOf('purchase')).toHaveLength(1);
    expect(bench.server.rowsOf('purchaseItem')).toHaveLength(2);
  });

  it('tells the person, in plain words, when the server refused a change, until dismissed', async () => {
    await store.enqueue('budget', 'no-such-purchase', { budget: 10 });
    await settle();

    expect(alerts()).toEqual([
      'Uma mudança não foi aceita e foi desfeita. Confira a lista. Entendi',
    ]);

    await click('Entendi');
    expect(alerts()).toEqual([]);
  });

  it('opens the people of the group from the list', async () => {
    await click('Pessoas');

    expect(el.querySelector('app-shopping-people')).not.toBeNull();
    expect(el.textContent).toContain('Neemias');
    await click('Voltar à lista');
    expect(el.querySelector('app-shopping-people')).toBeNull();
  });
});
