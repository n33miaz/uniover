import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { PX_PER_VOLUME_STEP } from '../input/volume-drag';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcVolume } from './volume';

describe('PcVolume strip', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcVolume>>;
  let strip: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  function fire(
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    x: number,
    pointerId = 1,
  ) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
    Object.assign(event, { pointerId, pointerType: 'touch' });
    strip.dispatchEvent(event);
  }
  const requests = () => store.sendMedia.mock.calls.map(([action, steps]) => [action, steps ?? 1]);

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcVolume);
    fixture.detectChanges();
    strip = fixture.nativeElement.querySelector('.strip');
    // O desenho do arrasto precisa só de uma largura; o captura de ponteiro não existe no ambiente de teste.
    strip.setPointerCapture = () => undefined;
    strip.getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
  });

  afterEach(() => fixture.destroy());

  it('dragging right raises the volume in steps, in the rhythm of the finger, one request at a time', async () => {
    let answer!: () => void;
    store.sendMedia.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(null))),
    );
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 3);
    expect(requests()).toEqual([['VOLUME_UP', 3]]);
    // O primeiro pedido ainda não voltou: o que o dedo anda depois espera, junto, para sair em um pedido só.
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 5);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 6);
    expect(requests()).toHaveLength(1);
    answer();
    await flush();
    expect(requests()).toEqual([
      ['VOLUME_UP', 3],
      ['VOLUME_UP', 3],
    ]);
  });

  it('dragging left lowers it, and a request never carries more than ten steps', async () => {
    fire('pointerdown', 300);
    fire('pointermove', 300 - PX_PER_VOLUME_STEP * 25);
    await flush();
    expect(requests()).toEqual([
      ['VOLUME_DOWN', 10],
      ['VOLUME_DOWN', 10],
      ['VOLUME_DOWN', 5],
    ]);
  });

  it('a touch that does not move sends nothing, and lifting the finger sends no more than what was walked', async () => {
    fire('pointerdown', 100);
    fire('pointerup', 100);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 2);
    fire('pointerup', 100 + PX_PER_VOLUME_STEP * 2);
    fire('pointermove', 400); // depois de soltar, o dedo não manda mais nada
    await flush();
    expect(requests()).toEqual([['VOLUME_UP', 2]]);
  });

  it('the thumb follows the finger inside the strip and goes back to the middle when it lets go', () => {
    const thumb = strip.querySelector<HTMLElement>('.thumb')!;
    fire('pointerdown', 100);
    fire('pointermove', 130);
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(true);
    expect(thumb.style.transform).not.toBe('translateX(0px)');
    fire('pointerup', 130);
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(false);
    expect(thumb.style.transform).toBe('translateX(0px)');
  });

  it('a second finger or a cancelled touch cannot leave the drag half open', async () => {
    fire('pointerdown', 100, 1);
    fire('pointerdown', 150, 2);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4, 2);
    expect(store.sendMedia).not.toHaveBeenCalled();
    fire('pointercancel', 100, 1);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4, 1);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
  });

  it('a failed request drops the rest of the drag instead of moving the volume blindly', async () => {
    store.sendMedia.mockResolvedValueOnce(FAILURE);
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 3);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 8);
    await flush();
    expect(requests()).toEqual([['VOLUME_UP', 3]]);
  });

  it('does nothing while the PC is not connected', async () => {
    store.phase.set('offline');
    fixture.detectChanges();
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 3);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
    expect(strip.classList.contains('off')).toBe(true);
  });

  it('is hidden from the screen reader (the buttons are the way for the keyboard)', () => {
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.hasAttribute('tabindex')).toBe(false);
  });
});
