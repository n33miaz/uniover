import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { ADVICE_RETRY_MS, formatBestDay, ShoppingAdviceCard } from './shopping-advice-card';

const ADVICE = '/api/v1/shopping/advice';

const READY = {
  available: true,
  reason: null,
  generatedAt: '2026-11-12T10:00:00Z',
  status: 'ok',
  bestDay: '2026-11-14',
  bestDayWeekday: 'friday',
  free: {
    salaryKnown: true,
    salaryDate: '2026-11-20',
    daysUntilSalary: 8,
    expectedSalaryCents: 500000,
    committedBeforeSalaryCents: 100000,
    committedAfterSalaryCents: 0,
    freeCents: 43210,
  },
};

describe('ShoppingAdviceCard', () => {
  let fixture: ComponentFixture<ShoppingAdviceCard>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let used: number[];

  function render(role: 'owner' | 'guest' = 'owner', budgetEmpty = true): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionState, useValue: { role: signal(role) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShoppingAdviceCard);
    fixture.componentRef.setInput('budgetEmpty', budgetEmpty);
    used = [];
    fixture.componentInstance.useAsBudget.subscribe((value) => used.push(value));
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  async function flush(body: object): Promise<void> {
    http.expectOne(ADVICE).flush(body);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  const text = (): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('shows what is free until payday and the best day, and turns it into the budget', async () => {
    render();
    await flush(READY);

    expect(text()).toContain('Livre até o salário');
    expect(text()).toContain('R$ 432,10');
    expect(text()).toContain('Melhor dia para comprar: sábado, 14/11');
    Array.from(el.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Usar como Teto'))!
      .click();
    expect(used).toEqual([432.1]);
  });

  it('offers the budget only while the purchase has none', async () => {
    render('owner', false);
    await flush(READY);
    expect(text()).not.toContain('Usar como Teto');
  });

  it('while the Economize wakes up, asks again after 5, 10, 20 and 40 s, then gives up', async () => {
    render();
    const waking = { ...READY, available: false, reason: 'waking', free: null };
    await flush(waking);
    expect(text()).toContain('Buscando no Economize');

    for (const delay of ADVICE_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      http.expectNone(ADVICE);
      await vi.advanceTimersByTimeAsync(1);
      await flush(waking);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    http.expectNone(ADVICE);
    expect(text()).toContain('Economize indisponível agora');
  });

  it('stops asking while the screen is hidden and resumes when it shows again', async () => {
    render();
    await flush({ ...READY, available: false, reason: 'waking', free: null });
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(ADVICE_RETRY_MS[0]);
    http.expectNone(ADVICE);

    hidden.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush(READY);
    expect(text()).toContain('Livre até o salário');
  });

  it.each([
    ['disabled', ''],
    ['unauthorized', 'Economize indisponível agora'],
    ['unavailable', 'Economize indisponível agora'],
  ])('reason %s shows "%s"', async (reason, shown) => {
    render();
    await flush({ ...READY, available: false, reason, free: null });
    expect(text()).toBe(shown);
  });

  it('shows nothing on a refusal (not the administrator on the server side)', async () => {
    render();
    http.expectOne(ADVICE).flush({ title: 'x' }, { status: 403, statusText: 'Forbidden' });
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(text()).toBe('');
  });

  it('a guest never asks', () => {
    render('guest');
    http.expectNone(ADVICE);
  });

  it('writes the best day the short Brazilian way', () => {
    expect(formatBestDay('2026-11-16')).toBe('segunda, 16/11');
  });
});
