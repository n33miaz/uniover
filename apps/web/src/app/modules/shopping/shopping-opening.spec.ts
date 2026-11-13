import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ShoppingActions } from './shopping-actions';
import { ShoppingHistoryPage } from './shopping-history.page';
import { ShoppingHubPage } from './shopping-hub.page';
import { ShoppingListPage } from './shopping-list.page';
import { ShoppingMarketPage } from './shopping-market.page';
import { ShoppingOpening } from './shopping-opening';
import { ShoppingSession } from './shopping-session';

describe('Compras: the list that has not opened', () => {
  const failed = signal(false);
  const retry = vi.fn();

  function mount(component: unknown): HTMLElement {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ShoppingSession, useValue: { store: signal(null), failed, retry } },
        {
          provide: ShoppingActions,
          useValue: { store: signal(null), snapshot: signal(null), purchase: signal(null), rows: signal([]) },
        },
      ],
    });
    const fixture = TestBed.createComponent(component as never);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    failed.set(false);
    retry.mockReset();
  });

  it('waits quietly while the storage opens', () => {
    const el = mount(ShoppingOpening);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Abrindo a lista');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('says in plain words that it did not open, with a button that tries again', () => {
    failed.set(true);
    const el = mount(ShoppingOpening);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível abrir a lista neste aparelho.',
    );
    const button = el.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Tentar de Novo');
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Lista', ShoppingListPage],
    ['Mercado Agora', ShoppingMarketPage],
    ['Histórico', ShoppingHistoryPage],
    ['a entrada', ShoppingHubPage],
  ])('%s shows the failure instead of an endless wait', (_name, page) => {
    failed.set(true);
    const el = mount(page);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível abrir');
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it('the entry still links to Detalhes when the storage did not open', () => {
    failed.set(true);
    const el = mount(ShoppingHubPage);
    expect(el.querySelector('a[href$="detalhes"]')).not.toBeNull();
  });
});
