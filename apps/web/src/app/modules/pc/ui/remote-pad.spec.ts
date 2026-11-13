import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PcArmed } from '../data/pc-armed';
import { remoteById, type RemoteId } from '../data/pc-remotes';
import { PcStore } from '../data/pc-store';
import {
  PC_KEY_V2_CAPABILITY,
  PC_TARGET_CAPABILITY,
  PC_TEXT_V2_CAPABILITY,
} from '../data/pc-types';
import { LONG_PRESS_MS } from '../input/pad-gesture';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcRemotePad } from './remote-pad';

/**
 * O que cada toque deve mandar: `key:` tecla (com modificadores), `media:` comando de mídia, `text:` texto digitado; `@programa` é o
 * `target` (o programa que precisa estar na frente no PC). A mídia nunca leva programa.
 */
type Sent = string;

/**
 * A tabela de casos: cada botão de cada controle, na ordem da tela, e o que o PC recebe. Escrita à mão (não lida dos dados),
 * para que um atalho trocado por engano nos dados quebre o teste.
 */
const CASES: Readonly<Record<RemoteId, readonly (readonly [string, Sent])[]>> = {
  navegador: [
    ['back', 'key:LEFT+ALT@browser'],
    ['reload', 'key:F5@browser'],
    ['forward', 'key:RIGHT+ALT@browser'],
    ['previous-tab', 'key:TAB+CTRL+SHIFT@browser'],
    ['new-tab', 'key:T+CTRL@browser'],
    ['next-tab', 'key:TAB+CTRL@browser'],
    ['zoom-out', 'key:MINUS+CTRL@browser'],
    ['close-tab', 'key:W+CTRL@browser'],
    ['zoom-in', 'key:EQUALS+CTRL@browser'],
    ['browser-fullscreen', 'key:F11@browser'],
  ],
  youtube: [
    ['back-10', 'key:J@browser'],
    ['play-pause', 'key:K@browser'],
    ['forward-10', 'key:L@browser'],
    ['volume-down', 'key:DOWN@browser'],
    ['mute', 'key:M@browser'],
    ['volume-up', 'key:UP@browser'],
    ['slower', 'key:COMMA+SHIFT@browser'],
    ['subtitles', 'key:C@browser'],
    ['faster', 'key:PERIOD+SHIFT@browser'],
    ['previous-video', 'key:P+SHIFT@browser'],
    ['fullscreen', 'key:F@browser'],
    ['next-video', 'key:N+SHIFT@browser'],
  ],
  netflix: [
    ['back-10', 'key:LEFT@browser'],
    ['play-pause', 'key:SPACE@browser'],
    ['forward-10', 'key:RIGHT@browser'],
    ['volume-down', 'key:DOWN@browser'],
    ['mute', 'key:M@browser'],
    ['volume-up', 'key:UP@browser'],
    ['skip-intro', 'key:S@browser'],
    ['fullscreen', 'key:F@browser'],
    ['exit-fullscreen', 'key:ESCAPE@browser'],
  ],
  spotify: [
    ['previous', 'media:PREVIOUS'],
    ['play-pause', 'media:PLAY_PAUSE'],
    ['next', 'media:NEXT'],
    ['volume-down', 'media:VOLUME_DOWN'],
    ['mute', 'media:MUTE'],
    ['volume-up', 'media:VOLUME_UP'],
    ['shuffle', 'key:S+CTRL@spotify'],
    ['like', 'key:B+ALT+SHIFT@spotify'],
    ['repeat', 'key:R+CTRL@spotify'],
  ],
  vlc: [
    ['back-10', 'key:LEFT+ALT@vlc'],
    ['play-pause', 'key:SPACE@vlc'],
    ['forward-10', 'key:RIGHT+ALT@vlc'],
    ['volume-down', 'key:DOWN+CTRL@vlc'],
    ['mute', 'key:M@vlc'],
    ['volume-up', 'key:UP+CTRL@vlc'],
    ['slower', 'key:MINUS@vlc'],
    ['normal-speed', 'key:EQUALS@vlc'],
    ['faster', 'text:+@vlc'],
    ['subtitles', 'key:V@vlc'],
    ['fullscreen', 'key:F@vlc'],
    ['stop', 'key:S@vlc'],
  ],
  'teclado-numerico': [
    ['1', 'key:D1'],
    ['2', 'key:D2'],
    ['3', 'key:D3'],
    ['4', 'key:D4'],
    ['5', 'key:D5'],
    ['6', 'key:D6'],
    ['7', 'key:D7'],
    ['8', 'key:D8'],
    ['9', 'key:D9'],
    [',', 'key:COMMA'],
    ['0', 'key:D0'],
    ['backspace', 'key:BACKSPACE'],
    ['-', 'key:MINUS'],
    ['.', 'key:PERIOD'],
    ['enter', 'key:ENTER'],
  ],
};

/** Os que só aparecem num PC com `pc.key.v2`. */
const V2_ONLY: Readonly<Record<RemoteId, readonly string[]>> = {
  navegador: ['zoom-out', 'zoom-in'],
  youtube: ['slower', 'faster'],
  netflix: [],
  spotify: [],
  vlc: ['slower', 'normal-speed'],
  'teclado-numerico': ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '-', '.'],
};

describe('PcRemotePad', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcRemotePad>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 12; round++) await Promise.resolve();
  };

  /** Tudo o que saiu para o PC, na ordem, no formato da tabela. */
  const sent = (): Sent[] => {
    const calls: { order: number; value: Sent }[] = [
      ...store.sendKey.mock.calls.map((call, i) => ({
        order: store.sendKey.mock.invocationCallOrder[i],
        value:
          ['key:' + call[0], ...((call[1] as readonly string[] | undefined) ?? [])].join('+') +
          (call[2]?.target ? '@' + call[2].target : ''),
      })),
      ...store.sendMedia.mock.calls.map((call, i) => ({
        order: store.sendMedia.mock.invocationCallOrder[i],
        value: 'media:' + call[0],
      })),
      ...store.sendText.mock.calls.map((call, i) => ({
        order: store.sendText.mock.invocationCallOrder[i],
        value: 'text:' + call[0] + (call[1] ? '@' + call[1] : ''),
      })),
      ...store.sendTextEdit.mock.calls.map((call, i) => ({
        order: store.sendTextEdit.mock.invocationCallOrder[i],
        value: 'text:' + (call[0].text ?? ''),
      })),
    ];
    return calls.sort((a, b) => a.order - b.order).map((call) => call.value);
  };

  const mount = (
    id: RemoteId,
    capabilities: readonly string[] = [PC_KEY_V2_CAPABILITY, PC_TARGET_CAPABILITY],
  ) => {
    store.capabilities.set(capabilities);
    fixture = TestBed.createComponent(PcRemotePad);
    fixture.componentRef.setInput('remote', remoteById(id)!);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  /** Segura o botão além do tempo do toque longo e solta. */
  const longPress = async (target: HTMLElement) => {
    vi.useFakeTimers();
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      target.click();
    } finally {
      vi.useRealTimers();
    }
  };

  /** O botão pelo id: os três grandes pela ordem (anterior, tocar, seguinte), os da grade pelo `data-button`. */
  const button = (id: RemoteId, buttonId: string): HTMLButtonElement => {
    const transport = remoteById(id)!.transport;
    if (transport) {
      const index = [transport.previous.id, transport.toggle.id, transport.next.id].indexOf(
        buttonId,
      );
      if (index >= 0)
        return root.querySelectorAll<HTMLButtonElement>('app-pc-transport button')[index];
    }
    return root.querySelector<HTMLButtonElement>(`.cell[data-button="${CSS.escape(buttonId)}"]`)!;
  };

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    TestBed.inject(PcStore);
  });

  afterEach(() => {
    fixture?.destroy();
    localStorage.clear();
  });

  for (const [id, cases] of Object.entries(CASES) as [RemoteId, (typeof CASES)[RemoteId]][]) {
    describe(id, () => {
      it.each(cases)('the button %s sends %s', async (buttonId, expected) => {
        mount(id);
        const target = button(id, buttonId);
        expect(target, buttonId).toBeTruthy();
        expect(target.disabled).toBe(false);
        if (target.classList.contains('hold')) await longPress(target);
        else target.click();
        await flush();
        expect(sent()).toEqual([expected]);
      });

      it('shows every button of the table, in the order of the table, and nothing more', () => {
        mount(id);
        const transport = remoteById(id)!.transport;
        const big = transport
          ? [transport.previous.id, transport.toggle.id, transport.next.id]
          : [];
        const cells = [...root.querySelectorAll('.cell')].map((cell) =>
          cell.getAttribute('data-button'),
        );
        expect([...big, ...cells]).toEqual(cases.map(([buttonId]) => buttonId));
        for (const cell of root.querySelectorAll('.cell')) {
          expect(cell.getAttribute('aria-label')).toBeTruthy();
        }
      });

      it('hides what needs pc.key.v2 on a PC that did not declare it', () => {
        mount(id, [PC_TARGET_CAPABILITY]);
        const cells = [...root.querySelectorAll('.cell')].map((cell) =>
          cell.getAttribute('data-button'),
        );
        for (const hidden of V2_ONLY[id]) expect(cells).not.toContain(hidden);
        const transport = remoteById(id)!.transport;
        const big = transport
          ? [transport.previous.id, transport.toggle.id, transport.next.id]
          : [];
        expect(cells).toEqual(
          cases
            .map(([buttonId]) => buttonId)
            .filter((b) => !big.includes(b) && !V2_ONLY[id].includes(b)),
        );
      });
    });
  }

  it('an armed key on the mouse screen does not join the button (no Ctrl+K on YouTube)', async () => {
    const armed = TestBed.inject(PcArmed);
    mount('youtube');
    armed.toggle('CTRL');
    button('youtube', 'play-pause').click();
    await flush();
    expect(sent()).toEqual(['key:K@browser']);
  });

  it('with the Alt of the window switcher held every button is off and nothing goes out', async () => {
    mount('vlc');
    store.heldKeys.set(['ALT']);
    fixture.detectChanges();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBe(12);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons.forEach((b) => b.click());
    await flush();
    expect(sent()).toEqual([]);
  });

  it('with the PC away nothing goes out', async () => {
    mount('spotify');
    store.phase.set('offline');
    fixture.detectChanges();
    button('spotify', 'play-pause').click();
    button('spotify', 'like').click();
    await flush();
    expect(sent()).toEqual([]);
  });

  describe('address bar', () => {
    const field = () => root.querySelector<HTMLInputElement>('input.field')!;
    const go = () => root.querySelector<HTMLButtonElement>('button.go')!;

    it('only the browser has it', () => {
      mount('youtube');
      expect(root.querySelector('input.field')).toBeNull();
      fixture.destroy();
      mount('navegador');
      expect(field()).toBeTruthy();
    });

    it('opens what was typed: Ctrl+L, the text and Enter, in this order, and empties the field', async () => {
      mount('navegador', [PC_KEY_V2_CAPABILITY, PC_TEXT_V2_CAPABILITY, PC_TARGET_CAPABILITY]);
      expect(go().disabled).toBe(true);
      field().value = '  uniover.app  ';
      field().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(go().disabled).toBe(false);
      go().click();
      await flush();
      fixture.detectChanges();
      expect(sent()).toEqual(['key:L+CTRL@browser', 'text:uniover.app', 'key:ENTER@browser']);
      expect(field().value).toBe('');
    });

    it('also works with an agent of the old text contract', async () => {
      mount('navegador', [PC_TARGET_CAPABILITY]);
      field().value = 'g1.com.br';
      field().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      go().click();
      await flush();
      expect(sent()).toEqual(['key:L+CTRL@browser', 'text:g1.com.br', 'key:ENTER@browser']);
    });

    it('an empty field sends nothing', async () => {
      mount('navegador');
      field().value = '   ';
      field().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      root.querySelector('form')!.dispatchEvent(new Event('submit'));
      await flush();
      expect(sent()).toEqual([]);
    });
  });

  describe('the program that must be in front', () => {
    const notice = () => root.querySelector('.notice')!.textContent!.trim();

    it('another program in front: the line says which program to open, and the next touch clears it', async () => {
      mount('youtube');
      store.sendKey.mockResolvedValueOnce({ kind: 'not-in-front', message: 'x' });
      button('youtube', 'play-pause').click();
      await flush();
      fixture.detectChanges();
      expect(notice()).toBe('Abra o YouTube no PC e deixe-o na frente.');
      button('youtube', 'mute').click();
      fixture.detectChanges();
      expect(notice()).toBe('');
    });

    it.each([
      ['navegador', 'Abra o navegador no PC e deixe-o na frente.'],
      ['netflix', 'Abra a Netflix no PC e deixe-a na frente.'],
      ['spotify', 'Abra o Spotify no PC e deixe-o na frente.'],
      ['vlc', 'Abra o VLC no PC e deixe-o na frente.'],
    ] as const)('%s names its own program', async (id, message) => {
      mount(id);
      store.sendKey.mockResolvedValueOnce({ kind: 'not-in-front', message: 'x' });
      const key = remoteById(id)!.buttons.find(
        (item) => item.action.kind === 'keys' && !item.hold,
      )!;
      button(id, key.id).click();
      await flush();
      fixture.detectChanges();
      expect(notice()).toBe(message);
    });

    it('the address bar: a refused Ctrl+L drops the text and the Enter', async () => {
      mount('navegador');
      store.sendKey.mockResolvedValueOnce({ kind: 'not-in-front', message: 'x' });
      const field = root.querySelector<HTMLInputElement>('input.field')!;
      field.value = 'uniover.app';
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      root.querySelector<HTMLButtonElement>('button.go')!.click();
      await flush();
      fixture.detectChanges();
      expect(sent()).toEqual(['key:L+CTRL@browser']);
      expect(notice()).toBe('Abra o navegador no PC e deixe-o na frente.');
    });

    it('a PC that does not check the window: keys are off, media still works, and the line asks to update', async () => {
      mount('spotify', [PC_KEY_V2_CAPABILITY]);
      expect(button('spotify', 'like').disabled).toBe(true);
      expect(button('spotify', 'shuffle').disabled).toBe(true);
      expect(button('spotify', 'play-pause').disabled).toBe(false);
      expect(button('spotify', 'volume-up').disabled).toBe(false);
      expect(notice()).toBe('Atualize o UniOver no PC para usar este controle.');
      button('spotify', 'play-pause').click();
      button('spotify', 'like').click();
      await flush();
      expect(sent()).toEqual(['media:PLAY_PAUSE']);
    });

    it('the number pad has no program and works on any PC with pc.key.v2', async () => {
      mount('teclado-numerico', [PC_KEY_V2_CAPABILITY]);
      expect(notice()).toBe('');
      button('teclado-numerico', '7').click();
      await flush();
      expect(sent()).toEqual(['key:D7']);
    });
  });

  describe('close tab only goes out when held', () => {
    const notice = () => root.querySelector('.notice')!.textContent!.trim();
    const close = () => button('navegador', 'close-tab');
    const down = () => close().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const up = () => close().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    afterEach(() => vi.useRealTimers());

    it('a short tap sends nothing and says to hold', async () => {
      mount('navegador');
      vi.useFakeTimers();
      down();
      vi.advanceTimersByTime(LONG_PRESS_MS - 100);
      up();
      close().click();
      vi.advanceTimersByTime(1000);
      await flush();
      fixture.detectChanges();
      expect(sent()).toEqual([]);
      expect(notice()).toBe('Segure para fechar');
    });

    it('a keyboard click sends nothing either: it only shows the hint', async () => {
      mount('navegador');
      close().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      await flush();
      fixture.detectChanges();
      expect(sent()).toEqual([]);
      expect(notice()).toBe('Segure para fechar');
    });

    it('holding sends one Ctrl+W, and keeping the finger there does not send another', async () => {
      mount('navegador');
      vi.useFakeTimers();
      down();
      vi.advanceTimersByTime(LONG_PRESS_MS * 5);
      up();
      close().click();
      await flush();
      expect(sent()).toEqual(['key:W+CTRL@browser']);
    });

    it('one at a time: a hold while the previous one is still on its way sends nothing', async () => {
      mount('navegador');
      let finish!: (value: null) => void;
      store.sendKey.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      vi.useFakeTimers();
      for (let round = 0; round < 2; round++) {
        down();
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
        up();
        await flush();
      }
      expect(sent()).toEqual(['key:W+CTRL@browser']);
      finish(null);
      await flush();
      down();
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      up();
      await flush();
      expect(sent()).toEqual(['key:W+CTRL@browser', 'key:W+CTRL@browser']);
    });

    it('a finger that leaves the button before the time sends nothing', async () => {
      mount('navegador');
      vi.useFakeTimers();
      down();
      vi.advanceTimersByTime(100);
      close().dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
      vi.advanceTimersByTime(1000);
      await flush();
      expect(sent()).toEqual([]);
    });
  });
});
