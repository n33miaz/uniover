import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcPinned } from '../data/pc-pinned';
import { PcStore } from '../data/pc-store';
import { MAX_PINNED, SHORTCUTS } from '../data/pc-shortcuts';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcShortcutGrid } from './shortcut-grid';

describe('PcShortcutGrid', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcShortcutGrid>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const cell = (id: string) => root.querySelector<HTMLButtonElement>(`[data-shortcut="${id}"]`)!;
  /** O primeiro botão do atalho: o dos fixados vem antes dos grupos. */
  const titles = () => [...root.querySelectorAll('.title')].map((item) => item.textContent?.trim());

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    TestBed.inject(PcStore);
    fixture = TestBed.createComponent(PcShortcutGrid);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.clear();
  });

  it('shows Pinned first and then every group, with what each shortcut does and its keys small', () => {
    expect(titles()).toEqual([
      'Fixados',
      'Edição',
      'Janela',
      'Sistema',
      'Navegador',
      'Vídeo',
      'Apresentação',
    ]);
    const copy = cell('copy');
    expect(copy.querySelector('.name')?.textContent?.trim()).toBe('Copiar');
    expect(copy.querySelector('.keys')?.textContent?.trim()).toBe('Ctrl+C');
  });

  it('tapping sends the shortcut as keys and modifiers, and the grid stays as it is', async () => {
    cell('copy').click();
    await flush();
    cell('switch-window').click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['C', ['CTRL']],
      ['TAB', ['ALT']],
    ]);
    expect(root.querySelectorAll('.cell').length).toBeGreaterThan(40);
  });

  it('the armed keys add to the shortcut and let go', async () => {
    TestBed.inject(PcArmed).toggle('SHIFT');
    cell('reload').click();
    await flush();
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('F5', ['SHIFT']);
    expect(TestBed.inject(PcArmed).armed().size).toBe(0);
  });

  it('Lock is the power action, not a key', async () => {
    cell('lock').click();
    await flush();
    expect(store.power).toHaveBeenCalledExactlyOnceWith('LOCK');
    expect(store.sendKey).not.toHaveBeenCalled();
  });

  it('a failure to lock is shown in the grid', async () => {
    store.power.mockResolvedValueOnce({ kind: 'offline', message: 'O PC está desconectado.' });
    cell('lock').click();
    await flush();
    fixture.detectChanges();
    expect(root.querySelector('.note')?.textContent).toContain('O PC está desconectado.');
  });

  it('every cell is off, and sends nothing, with the PC away', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    const cells = [...root.querySelectorAll<HTMLButtonElement>('.cell')];
    expect(cells.every((item) => item.disabled)).toBe(true);
    cells[0].click();
    expect(store.sendKey).not.toHaveBeenCalled();
  });

  it('the same shortcut also appears in its group when it is pinned', () => {
    expect(root.querySelectorAll('[data-shortcut="copy"]')).toHaveLength(2);
  });

  describe('editing', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('editing', true);
      fixture.detectChanges();
    });

    it('tapping pins and unpins instead of sending', async () => {
      const pinned = TestBed.inject(PcPinned);
      cell('save').click();
      await flush();
      expect(pinned.isPinned('save')).toBe(true);
      expect(store.sendKey).not.toHaveBeenCalled();
      fixture.detectChanges();
      expect(
        [...root.querySelectorAll('[data-shortcut="save"]')].every(
          (item) => item.getAttribute('aria-pressed') === 'true',
        ),
      ).toBe(true);
      cell('save').click();
      expect(pinned.isPinned('save')).toBe(false);
    });

    it('marks what is pinned with a pressed state, and everything else as not pressed', () => {
      const copies = [...root.querySelectorAll('[data-shortcut="copy"]')];
      expect(copies.every((item) => item.getAttribute('aria-pressed') === 'true')).toBe(true);
      expect(cell('save').getAttribute('aria-pressed')).toBe('false');
    });

    it('works with the PC away (it is only choosing)', () => {
      store.phase.set('offline');
      fixture.detectChanges();
      expect(cell('save').disabled).toBe(false);
    });

    it('says so when the pinned list is full', () => {
      const pinned = TestBed.inject(PcPinned);
      for (const shortcut of SHORTCUTS) {
        if (pinned.ids().length >= MAX_PINNED) break;
        pinned.toggle(shortcut.id);
      }
      const free = SHORTCUTS.find((shortcut) => !pinned.isPinned(shortcut.id))!;
      fixture.detectChanges();
      cell(free.id).click();
      fixture.detectChanges();
      expect(root.querySelector('.note')?.textContent).toContain('Fixados cheio');
      expect(pinned.isPinned(free.id)).toBe(false);
    });

    it('shows the Pinned group even when nothing is pinned, to say where they go', () => {
      const pinned = TestBed.inject(PcPinned);
      for (const id of [...pinned.ids()]) pinned.toggle(id);
      fixture.detectChanges();
      expect(titles()[0]).toBe('Fixados');
      fixture.componentRef.setInput('editing', false);
      fixture.detectChanges();
      expect(titles()[0]).toBe('Edição');
    });
  });
});
