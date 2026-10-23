import { signal, type WritableSignal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FoodRepository } from '../data/foods/food-repository';
import { MealRepository } from '../data/meals/meal-repository';
import { localFood } from '../data/foods/food-data-test-kit';
import { localMeal } from '../data/meals/meal-data-test-kit';
import { FoodDiaryPage } from './food-diary.page';

describe('FoodDiaryPage', () => {
  const food = localFood('food-a', { name: 'Iogurte natural' });
  const entry = localMeal('meal-a', { name: 'Iogurte natural', foodId: food.id });
  let foodRevision: WritableSignal<number>;
  let mealRevision: WritableSignal<number>;
  let foods: {
    revision: ReturnType<WritableSignal<number>['asReadonly']>;
    searchLocal: ReturnType<typeof vi.fn>;
    searchOnline: ReturnType<typeof vi.fn>;
    saveOwn: ReturnType<typeof vi.fn>;
  };
  let meals: {
    revision: ReturnType<WritableSignal<number>['asReadonly']>;
    today: ReturnType<typeof vi.fn>;
    entriesOf: ReturnType<typeof vi.fn>;
    addEntry: ReturnType<typeof vi.fn>;
    editEntry: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    TestBed.resetTestingModule();
  });

  async function open() {
    foodRevision = signal(0);
    mealRevision = signal(0);
    foods = {
      revision: foodRevision.asReadonly(),
      searchLocal: vi.fn(async (query: string) =>
        query.toLowerCase().includes('iogurte') ? [food] : [],
      ),
      searchOnline: vi.fn(async () => ({ status: 'ok', foods: [food] })),
      saveOwn: vi.fn(async () => ({ status: 'saved', food })),
    };
    meals = {
      revision: mealRevision.asReadonly(),
      today: vi.fn(() => '2026-10-23'),
      entriesOf: vi.fn(async () => []),
      addEntry: vi.fn(async () => ({ status: 'saved', entry })),
      editEntry: vi.fn(async () => ({ status: 'saved', entry })),
      softDelete: vi.fn(async () => ({ status: 'saved', entry })),
    };
    TestBed.configureTestingModule({
      imports: [FoodDiaryPage],
      providers: [
        provideRouter([]),
        { provide: FoodRepository, useValue: foods },
        { provide: MealRepository, useValue: meals },
      ],
    });
    const fixture = TestBed.createComponent(FoodDiaryPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  function button(fixture: ComponentFixture<FoodDiaryPage>, label: string): HTMLButtonElement {
    const element = fixture.nativeElement as HTMLElement;
    const found = Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }

  it('does not repeat remote search when applying results increments the food revision', async () => {
    const fixture = await open();
    const input = fixture.nativeElement.querySelector('#food-search') as HTMLInputElement;
    input.value = 'iogurte';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    button(fixture, 'Buscar').click();
    await vi.waitFor(() => expect(foods.searchOnline).toHaveBeenCalledTimes(1));
    foodRevision.update((value) => value + 1);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(foods.searchOnline).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('Iogurte natural');
  });

  it('ignores an older search response after the query changes', async () => {
    const fixture = await open();
    let finishOld!: (value: { status: 'ok'; foods: (typeof food)[] }) => void;
    foods.searchOnline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    foods.searchOnline.mockImplementationOnce(async () => ({ status: 'ok', foods: [food] }));
    const input = fixture.nativeElement.querySelector('#food-search') as HTMLInputElement;
    input.value = 'iogurte';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Buscar').click();
    fixture.detectChanges();

    input.value = 'outro';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button(fixture, 'Buscar').disabled).toBe(false);
    await fixture.whenStable();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    finishOld({ status: 'ok', foods: [localFood('stale', { name: 'Resultado antigo' })] });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Resultado antigo');
    expect(foods.searchOnline).toHaveBeenCalledTimes(2);
  });

  it('shows a day-load failure with a working retry action', async () => {
    const fixture = await open();
    meals.entriesOf.mockRejectedValueOnce(new Error('database unavailable'));
    await fixture.componentInstance['loadDay']();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível ler os lançamentos',
    );

    meals.entriesOf.mockResolvedValueOnce([entry]);
    button(fixture, 'Tentar novamente').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Iogurte natural');
  });

  it('rejects a free-form entry with a blank nutrient instead of treating it as zero', async () => {
    const fixture = await open();
    meals.addEntry.mockResolvedValue({ status: 'invalid' });
    button(fixture, 'Lançamento livre').click();
    fixture.detectChanges();
    const set = (selector: string, value: string) => {
      const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('#free-name', 'Refeição informada');
    set('#free-kcal', '0');
    set('#free-protein', '0');
    set('#free-carbs', '0');
    button(fixture, 'Registrar refeição').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(meals.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        nutrition: expect.objectContaining({ kcal: 0, proteinG: 0, carbG: 0, fatG: Number.NaN }),
      }),
    );
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Confira os campos',
    );

    const fat = fixture.nativeElement.querySelector('#free-fat') as HTMLInputElement;
    fat.value = '0';
    fat.dispatchEvent(new Event('input'));
    meals.addEntry.mockResolvedValue({ status: 'saved', entry });
    button(fixture, 'Registrar refeição').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(meals.addEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nutrition: { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
      }),
    );
  });

  it('shows save and own-food failures and clears the busy state', async () => {
    const fixture = await open();
    meals.addEntry.mockRejectedValue(new Error('storage unavailable'));
    foods.saveOwn.mockRejectedValue(new Error('storage unavailable'));
    const free = button(fixture, 'Lançamento livre');
    free.click();
    fixture.detectChanges();
    const name = fixture.nativeElement.querySelector('#free-name') as HTMLInputElement;
    name.value = 'Refeição';
    name.dispatchEvent(new Event('input'));
    for (const selector of ['#free-kcal', '#free-protein', '#free-carbs', '#free-fat']) {
      const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
      input.value = '0';
      input.dispatchEvent(new Event('input'));
    }
    button(fixture, 'Registrar refeição').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Confira os campos',
    );
    expect(button(fixture, 'Registrar refeição').disabled).toBe(false);

    button(fixture, 'Alimento').click();
    fixture.detectChanges();
    const own = fixture.nativeElement.querySelector('#own-name') as HTMLInputElement;
    own.value = 'Alimento';
    own.dispatchEvent(new Event('input'));
    for (const selector of ['#own-kcal', '#own-protein', '#own-carbs', '#own-fat']) {
      const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
      input.value = '0';
      input.dispatchEvent(new Event('input'));
    }
    const summary = fixture.nativeElement.querySelector('.own-food summary') as HTMLElement;
    summary.click();
    fixture.detectChanges();
    button(fixture, 'Salvar alimento').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Confira os campos',
    );
  });

  it('shows edit and delete failures without losing the entry', async () => {
    const fixture = await open();
    meals.entriesOf.mockResolvedValue([entry]);
    mealRevision.update((value) => value + 1);
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.entry-actions .text-button')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    meals.editEntry.mockRejectedValue(new Error('storage unavailable'));
    button(fixture, 'Salvar alterações').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Confira os campos',
    );
    expect(fixture.nativeElement.textContent).toContain('Iogurte natural');

    fixture.nativeElement.querySelector('.entry-actions .danger')?.click();
    fixture.detectChanges();
    button(fixture, 'Confirmar').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Confira os campos',
    );
    expect(fixture.nativeElement.textContent).toContain('Iogurte natural');
  });
});
