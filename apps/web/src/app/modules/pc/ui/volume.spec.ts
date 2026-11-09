import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { PX_PER_VOLUME_STEP } from '../input/volume-drag';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcVolume } from './volume';

describe('PcVolume buttons (the repeat while held)', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcVolume>>;
  let root: HTMLElement;

  const button = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  function fire(label: string, type: string) {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.assign(event, { pointerType: 'touch' });
    button(label).dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcVolume);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  /** Segurado por um tempo: o toque mais duas repetições. */
  async function holdAWhile() {
    fire('Aumentar o volume', 'pointerdown');
    await vi.advanceTimersByTimeAsync(420 + 190 * 2);
    return store.sendMedia.mock.calls.length;
  }

  it('stops when the pointer capture is lost', async () => {
    const sent = await holdAWhile();
    expect(sent).toBeGreaterThanOrEqual(3);
    fire('Aumentar o volume', 'lostpointercapture');
    await vi.advanceTimersByTimeAsync(190 * 5);
    expect(store.sendMedia).toHaveBeenCalledTimes(sent);
  });

  it('stops when the page is hidden (pagehide) and when it goes to the background', async () => {
    let sent = await holdAWhile();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(190 * 5);
    expect(store.sendMedia).toHaveBeenCalledTimes(sent);
    store.sendMedia.mockClear();
    sent = await holdAWhile();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(190 * 5);
      expect(store.sendMedia).toHaveBeenCalledTimes(sent);
    } finally {
      hidden.mockRestore();
    }
  });

  it('stops when the PC drops and sends no step while it is away, even from a timer already running', async () => {
    const sent = await holdAWhile();
    store.phase.set('offline');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(190 * 5);
    expect(store.sendMedia).toHaveBeenCalledTimes(sent);
  });

  it('leaves no repeat behind when the component goes away with the finger down', async () => {
    const sent = await holdAWhile();
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(190 * 5);
    expect(store.sendMedia).toHaveBeenCalledTimes(sent);
  });
});

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

  it('what was still waiting when the finger let go goes out only up to ten steps', async () => {
    let answer!: () => void;
    store.sendMedia.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(null))),
    );
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 40);
    fire('pointerup', 100 + PX_PER_VOLUME_STEP * 40);
    answer();
    await flush();
    expect(requests()).toEqual([
      ['VOLUME_UP', 1],
      ['VOLUME_UP', 10],
    ]);
  });

  it('without pointer capture the drag ends when the finger leaves the strip', async () => {
    strip.setPointerCapture = () => {
      throw new DOMException('gone', 'NotFoundError');
    };
    fire('pointerdown', 100);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 2);
    expect(requests()).toEqual([['VOLUME_UP', 2]]);
    strip.dispatchEvent(Object.assign(new MouseEvent('pointerleave'), { pointerId: 1 }));
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(false);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 9);
    await flush();
    expect(requests()).toEqual([['VOLUME_UP', 2]]);
  });

  it('without pointer capture the drag also ends when the finger goes up anywhere in the window', async () => {
    strip.setPointerCapture = () => {
      throw new DOMException('gone', 'NotFoundError');
    };
    fire('pointerdown', 100);
    window.dispatchEvent(Object.assign(new MouseEvent('pointerup'), { pointerId: 1 }));
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(false);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
  });

  it('with capture the finger leaving the strip does not end the drag', async () => {
    fire('pointerdown', 100);
    strip.dispatchEvent(Object.assign(new MouseEvent('pointerleave'), { pointerId: 1 }));
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(true);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 2);
    expect(requests()).toEqual([['VOLUME_UP', 2]]);
  });

  it('hiding the page or going to the background drops the drag in progress', async () => {
    fire('pointerdown', 100);
    window.dispatchEvent(new Event('pagehide'));
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(false);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      fire('pointerdown', 100, 2);
      document.dispatchEvent(new Event('visibilitychange'));
      fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4, 2);
      await flush();
      expect(store.sendMedia).not.toHaveBeenCalled();
    } finally {
      hidden.mockRestore();
    }
  });

  it('the PC dropping in the middle of a drag ends it', async () => {
    fire('pointerdown', 100);
    store.phase.set('offline');
    fixture.detectChanges();
    expect(strip.classList.contains('dragging')).toBe(false);
    fire('pointermove', 100 + PX_PER_VOLUME_STEP * 4);
    await flush();
    expect(store.sendMedia).not.toHaveBeenCalled();
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
