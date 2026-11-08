import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcInput } from '../data/pc-input';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcLiveKeyboard, SENTINEL } from './live-keyboard';

describe('PcLiveKeyboard', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcLiveKeyboard>>;
  let field: HTMLTextAreaElement;
  let notices: string[];
  let typingStates: boolean[];

  /** Deixa as continuações dos pedidos já respondidos rodarem. */
  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };

  /** O que o teclado do celular faz: o campo muda e o navegador avisa. */
  function type(value: string) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  beforeEach(() => {
    store = createFakePcStore();
    notices = [];
    typingStates = [];
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcLiveKeyboard);
    fixture.componentInstance.failed.subscribe((message) => notices.push(message));
    fixture.componentInstance.typing.subscribe((state) => typingStates.push(state));
    fixture.detectChanges();
    field = fixture.nativeElement.querySelector('textarea');
  });

  afterEach(() => fixture.destroy());

  it('starts with the invisible padding, so Backspace on an empty field still has something to delete', () => {
    expect(field.value).toBe(SENTINEL);
    expect(field.getAttribute('aria-label')).toBe('Digitar no PC');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  });

  it('a typed letter goes to the PC at once, with no send button', () => {
    type(SENTINEL + 'a');
    expect(store.sendText.mock.calls).toEqual([['a']]);
  });

  it('accents and emoji go whole', async () => {
    type(SENTINEL + 'olá');
    await flush();
    type(SENTINEL + 'olá 😀');
    expect(store.sendText.mock.calls).toEqual([['olá'], [' 😀']]);
  });

  it('what is typed while a request is in flight joins into one request', async () => {
    let finish!: () => void;
    store.sendText.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(null))),
    );
    type(SENTINEL + 'a');
    type(SENTINEL + 'ab');
    type(SENTINEL + 'abc');
    type(SENTINEL + 'abcd');
    expect(store.sendText.mock.calls).toEqual([['a']]);
    finish();
    await flush();
    expect(store.sendText.mock.calls).toEqual([['a'], ['bcd']]);
  });

  it('deleting a typed letter sends Backspace', async () => {
    type(SENTINEL + 'ab');
    await flush();
    type(SENTINEL + 'a');
    expect(store.sendKey.mock.calls).toEqual([['BACKSPACE', []]]);
  });

  it('a word swapped by the keyboard erases the old one and types the new one, in order', async () => {
    type(SENTINEL + 'helo');
    await flush();
    type(SENTINEL + 'hello');
    await flush();
    type(SENTINEL + 'hullo');
    await flush();
    expect(store.sendText.mock.calls.map(([text]) => text)).toEqual(['helo', 'lo', 'ullo']);
    // "helo" -> "hello" apaga uma letra; "hello" -> "hullo" apaga "ello" (quatro) e digita "ullo".
    expect(store.sendKey.mock.calls.filter(([key]) => key === 'BACKSPACE')).toHaveLength(5);
  });

  it('Enter and Tab are keys, never text, and the default of the field is cancelled', () => {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(store.sendKey).toHaveBeenLastCalledWith('ENTER', []);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    field.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(store.sendText).not.toHaveBeenCalled();
  });

  it('a line break the keyboard reports through beforeinput is Enter too', () => {
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.assign(event, { inputType: 'insertLineBreak' });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(store.sendKey).toHaveBeenCalledWith('ENTER', []);
  });

  it('Backspace with nothing left before the caret still reaches the PC', async () => {
    field.setSelectionRange(0, 0);
    const key = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(store.sendKey).toHaveBeenCalledWith('BACKSPACE', []);
    await flush();

    store.sendKey.mockClear();
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.assign(before, { inputType: 'deleteContentBackward' });
    field.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    expect(store.sendKey).toHaveBeenCalledWith('BACKSPACE', []);
  });

  it('Backspace with the caret inside the text is left to the field, which then reports the change', () => {
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
    const key = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(store.sendKey).not.toHaveBeenCalled();
  });

  it('typing with the caret before the padding sends the letter alone, never the padding', async () => {
    type('c' + SENTINEL);
    await flush();
    expect(store.sendText.mock.calls).toEqual([['c']]);
    expect(store.sendKey).not.toHaveBeenCalled();
  });

  it('selecting everything and typing over erases only what the PC really has', async () => {
    type(SENTINEL + 'ab');
    await flush();
    type('c');
    await flush();
    expect(store.sendKey.mock.calls.filter(([key]) => key === 'BACKSPACE')).toHaveLength(2);
    expect(store.sendText.mock.calls.map(([text]) => text)).toEqual(['ab', 'c']);
  });

  it('deleting into the padding sends Backspace too', () => {
    type(SENTINEL.slice(1));
    expect(store.sendKey.mock.calls).toEqual([['BACKSPACE', []]]);
  });

  it('with Ctrl armed, a single letter is the shortcut, not text, and leaves the field', async () => {
    TestBed.inject(PcArmed).toggle('CTRL');
    type(SENTINEL + 'c');
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('C', ['CTRL']);
    expect(store.sendText).not.toHaveBeenCalled();
    expect(field.value).toBe(SENTINEL);
    expect(TestBed.inject(PcArmed).armed().size).toBe(0);
    await flush();
    // O campo não guardou a letra: apagar depois não manda um Backspace de um texto que o PC nunca recebeu.
    type(SENTINEL + 'x');
    expect(store.sendText).toHaveBeenCalledWith('x');
  });

  it('other text with a key armed goes as text and lets the armed key go', () => {
    TestBed.inject(PcArmed).toggle('ALT');
    type(SENTINEL + 'ção');
    expect(store.sendText).toHaveBeenCalledWith('ção');
    expect(TestBed.inject(PcArmed).armed().size).toBe(0);
  });

  describe('keys from the screen', () => {
    it('go through the same line, after the text typed before them', async () => {
      let finish!: () => void;
      store.sendText.mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve(null))),
      );
      type(SENTINEL + 'oi');
      fixture.componentInstance.press('ENTER');
      expect(store.sendKey).not.toHaveBeenCalled();
      finish();
      await flush();
      expect(store.sendKey).toHaveBeenCalledWith('ENTER', []);
    });

    it('Backspace takes the last code point out of the field too, so the field and the PC stay equal', async () => {
      type(SENTINEL + 'a😀');
      await flush();
      fixture.componentInstance.press('BACKSPACE');
      await flush();
      expect(field.value).toBe(SENTINEL + 'a');
      type(SENTINEL + 'ab');
      expect(store.sendText).toHaveBeenLastCalledWith('b');
    });

    it('Enter and Tab start the field over', async () => {
      type(SENTINEL + 'abc');
      fixture.componentInstance.press('ENTER');
      expect(field.value).toBe(SENTINEL);
      type(SENTINEL + 'x');
      await flush();
      await flush();
      expect(store.sendText).toHaveBeenLastCalledWith('x');
    });

    it('carry what is armed and let it go', () => {
      TestBed.inject(PcArmed).toggle('SHIFT');
      fixture.componentInstance.press('TAB');
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('TAB', ['SHIFT']);
      expect(TestBed.inject(PcArmed).armed().size).toBe(0);
    });

    it('send nothing, and spend nothing armed, with the PC away', () => {
      store.phase.set('offline');
      TestBed.inject(PcArmed).toggle('CTRL');
      fixture.componentInstance.press('ENTER');
      expect(store.sendKey).not.toHaveBeenCalled();
      expect(TestBed.inject(PcArmed).has('CTRL')).toBe(true);
    });
  });

  describe('failures', () => {
    it('an uncertain failure warns that part of the text may not have arrived, and restarts the field', async () => {
      store.sendText.mockResolvedValueOnce({
        kind: 'timeout',
        message: 'O PC não respondeu a tempo.',
      });
      type(SENTINEL + 'abc');
      await flush();
      // O motivo ("não respondeu a tempo") já está no aviso de falha da tela; aqui entra o que ele não diz.
      expect(notices).toEqual(['Parte do texto pode não ter chegado.']);
      expect(field.value).toBe(SENTINEL);
      // A próxima digitação parte do que o PC tem: nenhum texto é devolvido ao campo.
      type(SENTINEL + 'z');
      expect(store.sendText).toHaveBeenLastCalledWith('z');
    });

    it('a failure the screen already shows (the reason) is not shown twice', async () => {
      store.sendText.mockResolvedValueOnce({ kind: 'forbidden', message: 'Sem permissão.' });
      type(SENTINEL + 'abc');
      await flush();
      expect(notices).toEqual([]);
      expect(field.value).toBe(SENTINEL);
    });

    it('a failure the store did not note (the PC went away) is shown here', async () => {
      store.sendText.mockResolvedValueOnce({ kind: 'offline', message: 'O PC está desconectado.' });
      type(SENTINEL + 'abc');
      await flush();
      expect(notices).toEqual(['O PC está desconectado.']);
    });

    it('a cancelled request says the text was not sent', async () => {
      store.sendText.mockResolvedValueOnce({ kind: 'cancelled', message: '' });
      type(SENTINEL + 'abc');
      await flush();
      expect(notices).toEqual(['O texto não foi enviado.']);
    });

    it('what waited behind the failed request is dropped, not typed after it', async () => {
      let fail!: () => void;
      store.sendText.mockImplementationOnce(
        () =>
          new Promise((resolve) => (fail = () => resolve({ kind: 'timeout', message: 'Tempo.' }))),
      );
      type(SENTINEL + 'a');
      type(SENTINEL + 'ab');
      type(SENTINEL + 'abc');
      fail();
      await flush();
      expect(store.sendText.mock.calls).toEqual([['a']]);
    });
  });

  it('refills the padding in silence once it has been used up', async () => {
    type('');
    await flush();
    expect(store.sendKey.mock.calls.filter(([key]) => key === 'BACKSPACE')).toHaveLength(6);
    expect(field.value).toBe(SENTINEL);
  });

  it('never refills in the middle of a composition', async () => {
    field.dispatchEvent(new Event('compositionstart'));
    type('');
    await flush();
    expect(field.value).toBe('');
    field.dispatchEvent(new Event('compositionend'));
  });

  it('tells when the keyboard mode turns on and off', () => {
    fixture.componentInstance.open();
    fixture.componentInstance.open();
    fixture.componentInstance.close();
    fixture.componentInstance.close();
    expect(typingStates).toEqual([true, false]);
  });

  it('a screen key takes the focus away, and restore brings it back while the keyboard mode is on', () => {
    fixture.componentInstance.open();
    // O toque nas teclas da tela avisa antes de o foco sair.
    fixture.componentInstance.holdFocus();
    field.blur();
    expect(fixture.componentInstance.focused).toBe(false);
    // A perda do foco não desliga o modo: o teclado do celular segue sendo o que a pessoa quer.
    expect(typingStates).toEqual([true]);
    fixture.componentInstance.restore();
    expect(document.activeElement).toBe(field);
  });

  it('restore does nothing once the keyboard was closed on purpose', () => {
    fixture.componentInstance.open();
    fixture.componentInstance.close();
    fixture.componentInstance.restore();
    expect(document.activeElement).not.toBe(field);
  });

  it('losing the PC ends the keyboard mode', () => {
    fixture.componentInstance.open();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(typingStates).toEqual([true, false]);
  });

  it('open focuses the field and close lets go of it', () => {
    expect(fixture.componentInstance.focused).toBe(false);
    fixture.componentInstance.open();
    expect(document.activeElement).toBe(field);
    fixture.componentInstance.close();
    expect(document.activeElement).not.toBe(field);
  });

  it('counts what is still waiting, for the key repeat to hold back', () => {
    store.sendKey.mockReturnValue(new Promise(() => undefined));
    fixture.componentInstance.press('BACKSPACE');
    fixture.componentInstance.press('BACKSPACE');
    expect(fixture.componentInstance.pending).toBe(2);
  });
});

describe('PcLiveKeyboard: round two', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcLiveKeyboard>>;
  let field: HTMLTextAreaElement;
  let notices: string[];
  let typingStates: boolean[];

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  function type(value: string) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const key = (name: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    field.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    notices = [];
    typingStates = [];
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcLiveKeyboard);
    fixture.componentInstance.failed.subscribe((message) => notices.push(message));
    fixture.componentInstance.typing.subscribe((state) => typingStates.push(state));
    fixture.detectChanges();
    field = fixture.nativeElement.querySelector('textarea');
  });
  afterEach(() => fixture.destroy());

  describe('a failed key with a text behind it', () => {
    it('restarts the field and says the text was not sent', async () => {
      store.sendKey.mockResolvedValueOnce({ kind: 'timeout', message: 'Tempo.' });
      fixture.componentInstance.press('ENTER');
      type(SENTINEL + 'oi');
      await flush();
      expect(notices).toEqual(['O texto não foi enviado.']);
      expect(field.value).toBe(SENTINEL);
      expect(store.sendText).not.toHaveBeenCalled();
      // O campo recomeçou do que o PC tem: o próximo texto sai inteiro, sem apagar nada.
      type(SENTINEL + 'z');
      expect(store.sendText).toHaveBeenCalledExactlyOnceWith('z');
    });

    it('a failed key with no text behind it leaves the field and the notice to the failure alone', async () => {
      store.sendKey.mockResolvedValueOnce({ kind: 'timeout', message: 'Tempo.' });
      type(SENTINEL + 'ab');
      await flush();
      fixture.componentInstance.press('ENTER');
      await flush();
      expect(notices).toEqual([]);
    });
  });

  describe('the keyboard mode follows the system', () => {
    it('a blur that is not a touch on the screen keys (Done on iOS) ends the mode', () => {
      fixture.componentInstance.open();
      expect(fixture.componentInstance.active).toBe(true);
      field.blur();
      expect(fixture.componentInstance.active).toBe(false);
      expect(typingStates).toEqual([true, false]);
      // O botão do teclado volta ao normal e uma tecla da tela não o reabre.
      fixture.componentInstance.restore();
      expect(document.activeElement).not.toBe(field);
    });

    it('a blur right after a touch on the screen keys does not', () => {
      fixture.componentInstance.open();
      fixture.componentInstance.holdFocus();
      field.blur();
      expect(fixture.componentInstance.active).toBe(true);
      fixture.componentInstance.restore();
      expect(document.activeElement).toBe(field);
    });

    it('the hold does not last: a later blur is the system again', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        fixture.componentInstance.open();
        fixture.componentInstance.holdFocus();
        vi.advanceTimersByTime(2_000);
        field.blur();
        expect(fixture.componentInstance.active).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the window growing back after the keyboard shrank it (Back on Android) ends the mode', () => {
      const listeners: (() => void)[] = [];
      const viewport = {
        height: 800,
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => undefined,
      };
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
      const second = TestBed.createComponent(PcLiveKeyboard);
      second.detectChanges();
      const states: boolean[] = [];
      second.componentInstance.typing.subscribe((state) => states.push(state));
      second.componentInstance.open();
      viewport.height = 450;
      listeners.forEach((listener) => listener());
      expect(second.componentInstance.active).toBe(true);
      viewport.height = 800;
      listeners.forEach((listener) => listener());
      expect(second.componentInstance.active).toBe(false);
      expect(states).toEqual([true, false]);
      second.destroy();
      Reflect.deleteProperty(window, 'visualViewport');
    });

    it('a window that never shrank does not end the mode (the keyboard overlays it)', () => {
      const listeners: (() => void)[] = [];
      const viewport = {
        height: 800,
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => undefined,
      };
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
      const second = TestBed.createComponent(PcLiveKeyboard);
      second.detectChanges();
      second.componentInstance.open();
      listeners.forEach((listener) => listener());
      expect(second.componentInstance.active).toBe(true);
      second.destroy();
      Reflect.deleteProperty(window, 'visualViewport');
    });
  });

  describe('after anything that changes the PC text from outside the field', () => {
    it.each(['ENTER', 'TAB'] as const)('%s restarts the field', (name) => {
      type(SENTINEL + 'abc');
      fixture.componentInstance.press(name);
      expect(field.value).toBe(SENTINEL);
    });

    it('a screen key with a modifier restarts the field (Ctrl+Z, Alt+Tab)', () => {
      type(SENTINEL + 'abc');
      TestBed.inject(PcArmed).toggle('CTRL');
      fixture.componentInstance.press('Z');
      expect(field.value).toBe(SENTINEL);
      type(SENTINEL + 'abc');
      fixture.componentInstance.press('TAB', ['ALT']);
      expect(field.value).toBe(SENTINEL);
    });

    it('a letter typed with a key armed (Ctrl+A, Ctrl+V) restarts the field too', async () => {
      type(SENTINEL + 'abc');
      await flush();
      TestBed.inject(PcArmed).toggle('CTRL');
      type(SENTINEL + 'abca');
      expect(store.sendKey).toHaveBeenLastCalledWith('A', ['CTRL']);
      expect(field.value).toBe(SENTINEL);
    });

    it('a shortcut from the grid or the sheet restarts it', () => {
      type(SENTINEL + 'abc');
      TestBed.inject(PcInput).shortcut('V', ['CTRL']);
      expect(field.value).toBe(SENTINEL);
      type(SENTINEL + 'abc');
      TestBed.inject(PcInput).shortcut('F5', []);
      expect(field.value).toBe(SENTINEL);
    });

    it('a plain screen key that does not touch the text leaves the field alone', () => {
      type(SENTINEL + 'abc');
      fixture.componentInstance.press('F5');
      expect(field.value).toBe(SENTINEL + 'abc');
    });
  });

  describe('Backspace of the phone keyboard is the key of the bar', () => {
    const backspaceAtStart = () => {
      field.setSelectionRange(0, 0);
      return key('Backspace');
    };

    it('with a key armed it goes out with the modifier and restarts the field', async () => {
      type(SENTINEL + 'abc');
      await flush();
      TestBed.inject(PcArmed).toggle('CTRL');
      field.setSelectionRange(0, 0);
      key('Backspace');
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('BACKSPACE', ['CTRL']);
      expect(field.value).toBe(SENTINEL);
      expect(TestBed.inject(PcArmed).armed().size).toBe(0);
    });

    it('deleting a typed letter with a key armed (caret inside the text) is the same key, not text', async () => {
      type(SENTINEL + 'abc');
      await flush();
      store.sendKey.mockClear();
      TestBed.inject(PcArmed).toggle('CTRL');
      type(SENTINEL + 'ab');
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('BACKSPACE', ['CTRL']);
      expect(field.value).toBe(SENTINEL);
    });

    it('goes out with no modifier when none is armed', () => {
      backspaceAtStart();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('BACKSPACE', []);
    });

    it('holding it on an empty field stops adding keys while two are unanswered, like the bar', () => {
      store.sendKey.mockReturnValue(new Promise(() => undefined));
      field.setSelectionRange(0, 0);
      key('Backspace');
      key('Backspace', { repeat: true });
      key('Backspace', { repeat: true });
      key('Backspace', { repeat: true });
      // Uma em voo e uma na fila: o resto das repetições pulou a rodada.
      expect(fixture.componentInstance.pending).toBe(2);
    });

    it('a deliberate second tap is not held back by the cap', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        store.sendKey.mockReturnValue(new Promise(() => undefined));
        field.setSelectionRange(0, 0);
        key('Backspace');
        vi.advanceTimersByTime(300);
        key('Backspace');
        vi.advanceTimersByTime(300);
        key('Backspace');
        expect(fixture.componentInstance.pending).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the repeat through beforeinput (mobile) uses the same cap', () => {
      store.sendKey.mockReturnValue(new Promise(() => undefined));
      field.setSelectionRange(0, 0);
      const before = () => {
        const event = new Event('beforeinput', { bubbles: true, cancelable: true });
        Object.assign(event, { inputType: 'deleteContentBackward' });
        field.dispatchEvent(event);
      };
      before();
      before();
      before();
      before();
      expect(fixture.componentInstance.pending).toBe(2);
    });
  });

  describe('composition', () => {
    it('Enter while composing (or keyCode 229) is the keyboard committing a word, not a key for the PC', () => {
      const composing = key('Enter', { isComposing: true });
      expect(composing.defaultPrevented).toBe(false);
      const ime = key('Enter', { keyCode: 229 });
      expect(ime.defaultPrevented).toBe(false);
      key('Tab', { isComposing: true });
      field.setSelectionRange(0, 0);
      key('Backspace', { isComposing: true });
      key('Backspace', { keyCode: 229 });
      expect(store.sendKey).not.toHaveBeenCalled();
    });

    it('a line break reported by beforeinput while composing is left alone', () => {
      const event = new Event('beforeinput', { bubbles: true, cancelable: true });
      Object.assign(event, { inputType: 'insertLineBreak', isComposing: true });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(store.sendKey).not.toHaveBeenCalled();
    });

    it('Enter outside a composition still goes to the PC', () => {
      const enter = key('Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(store.sendKey).toHaveBeenCalledWith('ENTER', []);
    });
  });

  describe('a text pasted with several lines', () => {
    it('is typed line by line, with Enter between them (the field takes line breaks)', async () => {
      expect(field.tagName).toBe('TEXTAREA');
      type(SENTINEL + 'um\ndois\r\ntrês');
      await flush();
      await flush();
      expect(store.sendText.mock.calls.map(([text]) => text)).toEqual(['um', 'dois', 'três']);
      expect(store.sendKey.mock.calls.map(([name]) => name)).toEqual(['ENTER', 'ENTER']);
    });
  });
});
