import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcSlidesPanel, SWIPE_MIN_PX } from './slides-panel';

describe('PcSlidesPanel', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcSlidesPanel>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 40; round++) await Promise.resolve();
  };
  const half = (action: 'previous' | 'next') =>
    root.querySelector<HTMLButtonElement>(`.half[data-action="${action}"]`)!;
  const cell = (id: string) => root.querySelector<HTMLButtonElement>(`[data-shortcut="${id}"]`)!;
  function pointer(type: 'pointerdown' | 'pointerup', target: Element, x: number, y = 100) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.assign(event, { pointerId: 1, pointerType: 'touch' });
    target.dispatchEvent(event);
  }
  /** O dedo anda de `from` a `to` sobre `target` e, como no navegador, o clique vem depois quando o alvo é o mesmo. */
  function swipe(target: Element, from: number, to: number, y = 0) {
    pointer('pointerdown', target, from);
    pointer('pointerup', target, to, 100 + y);
    (target as HTMLElement).click();
  }

  beforeEach(() => {
    store = createFakePcStore();
    store.capabilities.set(['pc.key.v2']);
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcSlidesPanel);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('previous and next are the two halves of the screen and send the arrows', async () => {
    half('next').click();
    half('previous').click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['RIGHT', []],
      ['LEFT', []],
    ]);
  });

  it('start, start here, end, black and white screen send the keys of the catalog', async () => {
    for (const id of [
      'slides-start',
      'slides-here',
      'slides-end',
      'slides-black',
      'slides-white',
    ]) {
      cell(id).click();
    }
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['F5', []],
      ['F5', ['SHIFT']],
      ['ESCAPE', []],
      ['B', []],
      ['W', []],
    ]);
  });

  it('swiping left brings the next slide and right the previous one, once each (no click on top)', async () => {
    swipe(half('previous'), 200, 100);
    swipe(half('next'), 100, 200);
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['RIGHT', []],
      ['LEFT', []],
    ]);
  });

  it('a tap that moves a little, or a mostly vertical drag, is a tap and not a swipe', async () => {
    swipe(half('next'), 100, 100 + SWIPE_MIN_PX - 5);
    swipe(half('next'), 100, 100 + SWIPE_MIN_PX + 10, 120);
    await flush();
    // Os dois terminam em clique do botão "Próximo": duas vezes seta para a direita.
    expect(store.sendKey.mock.calls).toEqual([
      ['RIGHT', []],
      ['RIGHT', []],
    ]);
  });

  it('a swipe that ends outside the buttons is not sent twice either', async () => {
    pointer('pointerdown', half('previous'), 200);
    pointer('pointerup', half('previous'), 100);
    await flush();
    expect(store.sendKey.mock.calls).toEqual([['RIGHT', []]]);
    // O próximo toque de verdade age, mesmo depois de um deslizar sem clique atrás.
    pointer('pointerdown', half('next'), 100);
    half('next').click();
    pointer('pointerup', half('next'), 100);
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['RIGHT', []],
      ['RIGHT', []],
    ]);
  });

  it('go to slide sends the digits and Enter, and is not there for a PC without pc.key.v2', async () => {
    const field = root.querySelector<HTMLInputElement>('.goto-input')!;
    field.value = '12';
    root.querySelector<HTMLButtonElement>('.goto-go')!.click();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['D1', []],
      ['D2', []],
      ['ENTER', []],
    ]);
    store.capabilities.set([]);
    fixture.detectChanges();
    expect(root.querySelector('.goto')).toBeNull();
  });

  it('has the local timer and nothing from the PC (no thumbnails, no notes)', () => {
    expect(root.querySelector('app-pc-slide-timer')).not.toBeNull();
    expect(root.querySelector('img, canvas, video')).toBeNull();
  });

  it('is disabled while the PC is not connected', async () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect(half('next').disabled).toBe(true);
    half('next').click();
    pointer('pointerdown', half('next'), 200);
    pointer('pointerup', half('next'), 100);
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
  });
});
