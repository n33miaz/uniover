import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { NumberPad } from './number-pad';

describe('NumberPad', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<NumberPad>>;
  let root: HTMLElement;

  beforeEach(() => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(NumberPad);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];

  it('has the ten digits and the source, and nothing else', () => {
    const labels = buttons().map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(labels).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => `Número ${n}`), 'Origem']);
  });

  it('puts the zero next to the source, over the two remaining columns', () => {
    expect(root.querySelector('.num.zero')?.getAttribute('aria-label')).toBe('Número 0');
    expect(root.querySelector('.source')?.textContent?.trim()).toBe('Origem');
  });

  it.each([
    ['Número 1', 'NUM_1'],
    ['Número 0', 'NUM_0'],
    ['Origem', 'INPUT'],
  ])('%s sends %s', async (label, key) => {
    const target = buttons().find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label,
    )!;
    target.click();
    await fixture.whenStable();
    expect(store.sendKey).toHaveBeenCalledWith(key);
  });

  it('is disabled when the remote cannot send', () => {
    store.canSend.set(false);
    fixture.detectChanges();
    for (const button of buttons()) expect(button.hasAttribute('disabled')).toBe(true);
  });
});
