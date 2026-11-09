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
  const tab = (id: string) =>
    root.querySelector<HTMLButtonElement>(`[role="tab"][data-mode="${id}"]`)!;
  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };

  function press(label: string, type: 'pointerdown' | 'pointerup' = 'pointerdown') {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.assign(event, { pointerType: 'touch' });
    named(label).dispatchEvent(event);
  }

  beforeEach(() => {
    localStorage.clear();
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
    localStorage.clear();
  });

  describe('modes', () => {
    it('has Music, Video and Slides in one tab list, with Music open', () => {
      expect([...root.querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim())).toEqual([
        'Música',
        'Vídeo',
        'Slides',
      ]);
      expect(tab('music').getAttribute('aria-selected')).toBe('true');
      expect(tab('video').getAttribute('aria-selected')).toBe('false');
      expect(root.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
        'pc-mode-music',
      );
      expect(named('Faixa anterior')).toBeDefined();
      expect(root.querySelector('app-pc-video-panel')).toBeNull();
      expect(root.querySelector('app-pc-slides-panel')).toBeNull();
    });

    it('switches the panel, and the volume stays for Music and Video but not for Slides', () => {
      tab('video').click();
      fixture.detectChanges();
      expect(root.querySelector('app-pc-video-panel')).not.toBeNull();
      expect(root.querySelector('app-pc-volume')).not.toBeNull();
      expect(named('Faixa anterior')).toBeUndefined();
      tab('slides').click();
      fixture.detectChanges();
      expect(root.querySelector('app-pc-slides-panel')).not.toBeNull();
      expect(root.querySelector('app-pc-volume')).toBeNull();
      expect(tab('slides').getAttribute('aria-selected')).toBe('true');
      expect(tab('slides').getAttribute('tabindex')).toBe('0');
      expect(tab('music').getAttribute('tabindex')).toBe('-1');
    });

    it('the arrow keys move between the modes, with the focus, and wrap around', async () => {
      const key = (value: string) =>
        root
          .querySelector('[role="tab"][aria-selected="true"]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
      key('ArrowRight');
      fixture.detectChanges();
      expect(tab('video').getAttribute('aria-selected')).toBe('true');
      key('ArrowLeft');
      key('ArrowLeft');
      fixture.detectChanges();
      expect(tab('slides').getAttribute('aria-selected')).toBe('true');
      key('Enter');
      expect(tab('slides').getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('Music', () => {
    it('the transport buttons, mute and stop send the media commands', () => {
      named('Tocar ou pausar').click();
      named('Próxima faixa').click();
      named('Faixa anterior').click();
      named('Mudo').click();
      named('Parar').click();
      expect(store.sendMedia.mock.calls.map(([action]) => action)).toEqual([
        'PLAY_PAUSE',
        'NEXT',
        'PREVIOUS',
        'MUTE',
        'STOP',
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

    it('keeps repeating while a step is still waiting for the PC, up to three at once, and goes on as they come back', async () => {
      const answers: (() => void)[] = [];
      store.sendMedia.mockImplementation(
        () => new Promise((resolve) => answers.push(() => resolve(null))),
      );
      press('Aumentar o volume');
      // O primeiro passo vem no toque e a repetição começa depois: com a rede lenta, nenhum voltou e já há três no ar.
      await vi.advanceTimersByTimeAsync(420 + 190 * 8);
      expect(store.sendMedia).toHaveBeenCalledTimes(3);
      // Uma resposta volta: a repetição, que seguia viva, ocupa a vaga na rodada seguinte.
      answers[0]();
      await vi.advanceTimersByTimeAsync(190);
      expect(store.sendMedia).toHaveBeenCalledTimes(4);
      // E o teto segue valendo: mais rodadas sem resposta não mandam além de três em voo.
      await vi.advanceTimersByTimeAsync(190 * 5);
      expect(store.sendMedia).toHaveBeenCalledTimes(4);
      press('Aumentar o volume', 'pointerup');
    });

    it('the repeat stops when the PC drops, with the finger still down, and does not come back with it', async () => {
      press('Aumentar o volume');
      await vi.advanceTimersByTimeAsync(420 + 190 * 2);
      store.phase.set('offline');
      fixture.detectChanges();
      const sent = store.sendMedia.mock.calls.length;
      await vi.advanceTimersByTimeAsync(190 * 5);
      expect(store.sendMedia).toHaveBeenCalledTimes(sent);
      store.phase.set('ready');
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(190 * 5);
      expect(store.sendMedia).toHaveBeenCalledTimes(sent);
    });

    it('the repeat stops when the mode changes, with the finger still down', async () => {
      press('Aumentar o volume');
      await vi.advanceTimersByTimeAsync(420 + 190 * 2);
      tab('slides').click();
      fixture.detectChanges();
      const sent = store.sendMedia.mock.calls.length;
      await vi.advanceTimersByTimeAsync(190 * 5);
      expect(store.sendMedia).toHaveBeenCalledTimes(sent);
    });

    it('keyboard and screen reader activation (a click with no pointer) also change the volume', () => {
      named('Aumentar o volume').click();
      expect(store.sendMedia).toHaveBeenCalledExactlyOnceWith('VOLUME_UP');
    });
  });

  describe('favorites', () => {
    it('shows no favorites section when the PC offers none', () => {
      expect(root.querySelector('.apps')).toBeNull();
    });

    it('lists the favorites of the PC in a grid and opens the chosen one, in any mode', async () => {
      store.apps.set([
        { id: 'navegador', label: 'Navegador' },
        { id: 'notas', label: 'Notas' },
      ]);
      tab('slides').click();
      fixture.detectChanges();
      expect([...root.querySelectorAll('.app .name')].map((b) => b.textContent?.trim())).toEqual([
        'Navegador',
        'Notas',
      ]);
      expect([...root.querySelectorAll('.app .badge')].map((b) => b.textContent?.trim())).toEqual([
        'N',
        'N',
      ]);
      root.querySelector<HTMLButtonElement>('[data-app="notas"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.launch).toHaveBeenCalledExactlyOnceWith('notas');
    });

    it('says why a favorite did not open', async () => {
      store.apps.set([{ id: 'notas', label: 'Notas' }]);
      store.launch.mockResolvedValueOnce(FAILURE);
      fixture.detectChanges();
      root.querySelector<HTMLButtonElement>('[data-app="notas"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
    });
  });

  it('every command button is disabled while the PC is not connected (the mode tabs still work)', async () => {
    store.phase.set('offline');
    store.apps.set([{ id: 'notas', label: 'Notas' }]);
    fixture.detectChanges();
    // O cronômetro é só da tela (não manda nada ao PC): fica de fora.
    const buttons = (): HTMLButtonElement[] =>
      [...root.querySelectorAll<HTMLButtonElement>('button:not([role="tab"])')].filter(
        (b) => !b.closest('app-pc-slide-timer'),
      );
    expect(buttons().length).toBeGreaterThan(5);
    expect(buttons().every((b) => b.disabled)).toBe(true);
    for (const id of ['video', 'slides']) {
      tab(id).click();
      fixture.detectChanges();
      await flush();
      expect(buttons().length, id).toBeGreaterThan(3);
      expect(
        buttons().every((b) => b.disabled),
        id,
      ).toBe(true);
    }
  });
});
