import { TestBed } from '@angular/core/testing';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { SuggestionSheet } from './suggestion-sheet';

describe('SuggestionSheet', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<SuggestionSheet>>;
  let root: HTMLElement;
  let done: ReturnType<typeof vi.fn<() => void>>;
  let choose: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim());
  const click = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === text)!
      .click();

  const mount = (app: TvShortcut) => {
    store = createFakeTvStore();
    store.shortcuts.set([app]);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(SuggestionSheet);
    fixture.componentRef.setInput('app', app);
    done = vi.fn<() => void>();
    choose = vi.fn<() => void>();
    fixture.componentInstance.done.subscribe(done);
    fixture.componentInstance.choose.subscribe(choose);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  const netflix = (overrides: Partial<TvShortcut> = {}) =>
    makeShortcut(4, {
      package: 'com.netflix.ninja',
      tvLabel: 'Netflix',
      enabled: false,
      ...overrides,
    });

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('shows the installed app with the icon the TV sent, and pins it to the control', async () => {
    mount(netflix({ iconDataUri: pngIcon(96, 96) }));
    expect(root.querySelector('.ui-chip')?.textContent?.trim()).toBe('Sugestão');
    expect(root.querySelector('app-tv-app-icon img')).not.toBeNull();
    expect(buttons()).toEqual(['Fixar no controle', 'Escolher outro app', 'Remover sugestão']);
    click('Fixar no controle');
    await fixture.whenStable();
    expect(store.setShortcutEnabled).toHaveBeenCalledWith('s4', true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('without an icon from the TV, draws a brand-like tile with the initial (never a logo)', () => {
    mount(netflix());
    const tile = root.querySelector<HTMLElement>('app-tv-app-icon .fallback')!;
    expect(tile.textContent?.trim()).toBe('N');
    expect(tile.classList.contains('brand')).toBe(true);
    expect(root.querySelector('app-tv-app-icon img')).toBeNull();
  });

  it('stays open when the server refuses', async () => {
    mount(netflix());
    store.setShortcutEnabled.mockResolvedValue(false);
    click('Fixar no controle');
    await fixture.whenStable();
    expect(done).not.toHaveBeenCalled();
  });

  it('asks for the app picker, announced as opening a dialog', () => {
    mount(netflix());
    const other = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Escolher outro app',
    )!;
    expect(other.getAttribute('aria-haspopup')).toBe('dialog');
    other.click();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(store.setShortcutEnabled).not.toHaveBeenCalled();
  });

  it('removes the suggestion by package for this account and closes', () => {
    mount(netflix());
    click('Remover sugestão');
    expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual(['com.netflix.ninja']);
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.setShortcutEnabled).not.toHaveBeenCalled();
  });
});
