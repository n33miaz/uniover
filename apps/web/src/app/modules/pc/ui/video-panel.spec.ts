import { TestBed } from '@angular/core/testing';
import { PcPrefs } from '../data/pc-prefs';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcVideoPanel } from './video-panel';

describe('PcVideoPanel', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcVideoPanel>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const named = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const cell = (id: string) => root.querySelector<HTMLButtonElement>(`[data-shortcut="${id}"]`)!;

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    TestBed.inject(PcStore);
    fixture = TestBed.createComponent(PcVideoPanel);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.clear();
  });

  it('jumps 10 seconds back and forward and plays or pauses, with the keys of a video player', async () => {
    named('Voltar 10 segundos').click();
    named('Tocar ou pausar').click();
    named('Avançar 10 segundos').click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['J', []],
      ['SPACE', []],
      ['L', []],
    ]);
  });

  it('has 5 seconds back and forward, full screen and subtitles from the catalog, all with keys of the old contract', async () => {
    const ids = ['video-back-5', 'video-forward-5', 'video-fullscreen', 'video-subtitles'];
    expect([...root.querySelectorAll('.cell')].map((b) => b.getAttribute('data-shortcut'))).toEqual(
      ids,
    );
    for (const id of ids) cell(id).click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['LEFT', []],
      ['RIGHT', []],
      ['F', []],
      ['C', []],
    ]);
  });

  it('with the Alt of the window switcher held every button is off and nothing goes out as Alt+key', async () => {
    store.heldKeys.set(['ALT']);
    fixture.detectChanges();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBe(7);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons[0].click();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
    expect(TestBed.inject(PcPrefs).videoHintSeen()).toBe(false);
  });

  it('warns once that the player needs focus, and the warning goes away with the first touch for good', () => {
    const warning = () => root.querySelector('.hint')?.textContent?.trim();
    expect(warning()).toBe('O player precisa estar em foco.');
    named('Voltar 10 segundos').click();
    fixture.detectChanges();
    expect(warning()).toBeUndefined();
    expect(TestBed.inject(PcPrefs).videoHintSeen()).toBe(true);
    fixture.destroy();
    const again = TestBed.createComponent(PcVideoPanel);
    again.detectChanges();
    expect(again.nativeElement.querySelector('.hint')).toBeNull();
  });

  it('a cell also takes the warning away, and a touch that did not go out does not', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    named('Voltar 10 segundos').click();
    expect(TestBed.inject(PcPrefs).videoHintSeen()).toBe(false);
    store.phase.set('ready');
    fixture.detectChanges();
    cell('video-fullscreen').click();
    expect(TestBed.inject(PcPrefs).videoHintSeen()).toBe(true);
  });
});
