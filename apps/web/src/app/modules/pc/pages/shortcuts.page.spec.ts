import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { ShortcutsPage } from './shortcuts.page';

describe('ShortcutsPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ShortcutsPage>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(ShortcutsPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.clear();
  });

  it('shows the whole catalog in the tab itself, with no explanatory text', () => {
    expect(root.querySelectorAll('app-pc-shortcut-grid .group').length).toBe(7);
    expect(root.querySelectorAll('p').length).toBe(0);
  });

  it('a tap sends the shortcut', async () => {
    root.querySelector<HTMLButtonElement>('[data-shortcut="new-tab"]')!.click();
    await flush();
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('T', ['CTRL']);
  });

  it('the pencil switches to editing, where a tap pins', async () => {
    const pencil = root.querySelector<HTMLButtonElement>('button[aria-label="Editar fixados"]')!;
    pencil.click();
    fixture.detectChanges();
    expect(pencil.getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-shortcut="new-tab"]')!.click();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
  });
});
