import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcShortcutCells } from './shortcut-cells';

@Component({
  imports: [PcShortcutCells],
  template: `<app-pc-shortcut-cells [ids]="ids" [columns]="2" (used)="used.push($event)" />`,
})
class Host {
  ids: readonly string[] = [
    'video-back-5',
    'slides-start',
    'slides-here',
    'zoom-in',
    'lock',
    'nope',
  ];
  readonly used: string[] = [];
}

describe('PcShortcutCells', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const cell = (id: string) => root.querySelector<HTMLButtonElement>(`[data-shortcut="${id}"]`)!;

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('shows only catalog shortcuts that are keys, with the name and the keys small', () => {
    // `lock` não é tecla e `nope` não existe; `zoom-in` precisa da `pc.key.v2`, que este PC não declarou.
    expect([...root.querySelectorAll('.cell')].map((b) => b.getAttribute('data-shortcut'))).toEqual(
      ['video-back-5', 'slides-start', 'slides-here'],
    );
    expect(cell('slides-here').querySelector('.name')?.textContent?.trim()).toBe('Iniciar Daqui');
    expect(cell('slides-here').querySelector('.keys')?.textContent?.trim()).toBe('Shift+F5');
    expect(
      root.querySelector<HTMLElement>('app-pc-shortcut-cells')!.style.getPropertyValue('--cols'),
    ).toBe('2');
  });

  it('shows what needs pc.key.v2 once the PC declares it', () => {
    store.capabilities.set(['pc.key.v2']);
    fixture.detectChanges();
    expect(cell('zoom-in')).not.toBeNull();
  });

  it('sends the key with its own modifiers and nothing else, even with Ctrl armed on the mouse screen', async () => {
    const armed = TestBed.inject(PcArmed);
    armed.toggle('CTRL');
    cell('slides-here').click();
    cell('video-back-5').click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['F5', ['SHIFT']],
      ['LEFT', []],
    ]);
    expect(armed.has('CTRL')).toBe(true);
    expect(fixture.componentInstance.used).toEqual(['slides-here', 'video-back-5']);
  });

  it('is disabled and sends nothing while the PC is not connected', async () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect(cell('slides-start').disabled).toBe(true);
    cell('slides-start').click();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
    expect(fixture.componentInstance.used).toEqual([]);
  });
});
