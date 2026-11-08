import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcShortcutSheet } from './shortcut-sheet';

describe('PcShortcutSheet', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcShortcutSheet>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const button = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  beforeEach(async () => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcShortcutSheet);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.clear();
  });

  it('opens as a modal named Shortcuts', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Atalhos');
    expect(dialog.getAttribute('aria-labelledby')).toBe('pc-shortcuts-title');
  });

  it('starts with the focus on the title, so no button looks switched on', () => {
    expect(document.activeElement).toBe(root.querySelector('h2'));
  });

  it('shows the armed keys in the sheet header, and a tap on one lets it go', () => {
    const armed = TestBed.inject(PcArmed);
    expect(root.querySelector('app-pc-armed-pills .pill')).toBeNull();
    armed.toggle('WIN');
    fixture.detectChanges();
    const pill = root.querySelector<HTMLButtonElement>('app-pc-armed-pills .pill')!;
    expect(pill.textContent?.trim()).toBe('Win');
    expect(pill.getAttribute('aria-label')).toBe('Soltar Win');
    pill.click();
    fixture.detectChanges();
    TestBed.tick();
    expect(armed.has('WIN')).toBe(false);
    // O foco não se perde: com a última pílula fora, vai para o título da folha.
    expect(document.activeElement).toBe(root.querySelector('h2'));
    expect(root.querySelector('app-pc-armed-pills .pill')).toBeNull();
  });

  it('the armed key goes with the shortcut that is tapped, and the pill goes away', async () => {
    TestBed.inject(PcArmed).toggle('WIN');
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[data-shortcut="find"]')!.click();
    await flush();
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('F', ['CTRL', 'WIN']);
    fixture.detectChanges();
    expect(root.querySelector('app-pc-armed-pills .pill')).toBeNull();
  });

  it('stays open after a tap, so the next tap chains', async () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    root.querySelector<HTMLButtonElement>('[data-shortcut="switch-window"]')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('[data-shortcut="switch-window"]')!.click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['TAB', ['ALT']],
      ['TAB', ['ALT']],
    ]);
    expect(closed).toBe(0);
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('the X closes it', () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    button('Fechar').click();
    expect(closed).toBe(1);
  });

  it('the pencil turns editing on and off, and while on a tap pins instead of sending', async () => {
    expect(button('Editar fixados').getAttribute('aria-pressed')).toBe('false');
    button('Editar fixados').click();
    fixture.detectChanges();
    expect(button('Editar fixados').getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-shortcut="save"]')!.click();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
    button('Editar fixados').click();
    fixture.detectChanges();
    expect(button('Editar fixados').getAttribute('aria-pressed')).toBe('false');
  });

  it('Drag holds the left button and shows it as pressed while held', () => {
    const drag = root.querySelector<HTMLButtonElement>('.drag')!;
    expect(drag.textContent?.trim()).toBe('Arrastar');
    drag.click();
    expect(store.toggleDrag).toHaveBeenCalledTimes(1);
    store.dragging.set(true);
    fixture.detectChanges();
    expect(drag.getAttribute('aria-pressed')).toBe('true');
  });

  it('Drag stays reachable to release while held, even with the PC away', () => {
    store.dragging.set(true);
    store.phase.set('offline');
    fixture.detectChanges();
    expect(root.querySelector<HTMLButtonElement>('.drag')!.disabled).toBe(false);
  });
});
