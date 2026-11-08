import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcLiveKeyboard, SENTINEL } from './live-keyboard';

describe('PcLiveKeyboard', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcLiveKeyboard>>;
  let field: HTMLInputElement;
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
    field = fixture.nativeElement.querySelector('input');
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
