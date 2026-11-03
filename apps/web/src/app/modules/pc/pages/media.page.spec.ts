import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { MediaPage } from './media.page';

describe('MediaPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<MediaPage>>;
  let root: HTMLElement;

  const named = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
    )!;

  function press(label: string, type: 'pointerdown' | 'pointerup' = 'pointerdown') {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.assign(event, { pointerType: 'touch' });
    named(label).dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(MediaPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('the transport buttons send the media keys', () => {
    named('Tocar ou pausar').click();
    named('Próxima faixa').click();
    named('Faixa anterior').click();
    named('Mudo').click();
    expect(store.sendMedia.mock.calls.map(([action]) => action)).toEqual([
      'PLAY_PAUSE',
      'NEXT',
      'PREVIOUS',
      'MUTE',
    ]);
  });

  it('a short press on the volume sends one step and never repeats', async () => {
    press('Aumentar o volume');
    press('Aumentar o volume', 'pointerup');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.sendMedia).toHaveBeenCalledTimes(1);
    expect(store.sendMedia).toHaveBeenCalledWith('VOLUME_UP');
  });

  it('holding the volume repeats it until the finger leaves', async () => {
    press('Diminuir o volume');
    await vi.advanceTimersByTimeAsync(420 + 190 * 3);
    const held = store.sendMedia.mock.calls.length;
    expect(held).toBeGreaterThanOrEqual(3);
    expect(store.sendMedia.mock.calls.every(([action]) => action === 'VOLUME_DOWN')).toBe(true);
    press('Diminuir o volume', 'pointerup');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.sendMedia).toHaveBeenCalledTimes(held);
  });

  it('keyboard and screen reader activation (a click with no pointer) also change the volume', () => {
    named('Aumentar o volume').click();
    expect(store.sendMedia).toHaveBeenCalledExactlyOnceWith('VOLUME_UP');
  });

  it('shows no favorites section when the PC offers none', () => {
    expect(root.querySelector('.apps')).toBeNull();
  });

  it('lists the favorites of the PC and opens the chosen one', async () => {
    store.apps.set([
      { id: 'navegador', label: 'Navegador' },
      { id: 'notas', label: 'Notas' },
    ]);
    fixture.detectChanges();
    expect([...root.querySelectorAll('.app')].map((b) => b.textContent?.trim())).toEqual([
      'Navegador',
      'Notas',
    ]);
    named('Notas').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.launch).toHaveBeenCalledExactlyOnceWith('notas');
  });

  it('says why a favorite did not open', async () => {
    store.apps.set([{ id: 'notas', label: 'Notas' }]);
    store.launch.mockResolvedValueOnce(FAILURE);
    fixture.detectChanges();
    named('Notas').click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
  });

  it('is all disabled while the PC is not connected', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect([...root.querySelectorAll<HTMLButtonElement>('button')].every((b) => b.disabled)).toBe(
      true,
    );
  });
});
