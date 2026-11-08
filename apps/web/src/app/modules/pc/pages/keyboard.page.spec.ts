import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { KeyboardPage } from './keyboard.page';

describe('KeyboardPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<KeyboardPage>>;
  let root: HTMLElement;

  const field = () => root.querySelector<HTMLInputElement>('#pc-text')!;
  const submit = () => root.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const named = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.key')].find(
      (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
    )!;

  function type(text: string) {
    field().value = text;
    field().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(KeyboardPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('has a labelled field; the HTML limit is the worst case in UTF-16 units, the real one is by code points', () => {
    expect(root.querySelector('label[for=pc-text]')).not.toBeNull();
    expect(field().maxLength).toBe(400);
    // 16px: abaixo disso o Safari do iPhone dá zoom ao focar o campo.
    expect(field().getAttribute('autocomplete')).toBe('off');
  });

  it('only lets the text go once there is something to type', () => {
    expect(submit().disabled).toBe(true);
    type('olá');
    expect(submit().disabled).toBe(false);
  });

  it('sends the text, then empties the field so nothing typed stays on screen', async () => {
    type('minha senha');
    submit().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.sendText).toHaveBeenCalledExactlyOnceWith('minha senha');
    expect(field().value).toBe('');
  });

  it('keeps the text and shows the reason when it could not be sent', async () => {
    store.sendText.mockResolvedValueOnce(FAILURE);
    type('oi');
    submit().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('oi');
    expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
  });

  it('empties the field at once and does not wait for the answer before the next text', async () => {
    store.sendText.mockImplementation(() => new Promise<never>(() => undefined));
    type('um');
    submit().click();
    fixture.detectChanges();
    expect(field().value).toBe('');
    expect(submit().disabled).toBe(true);
    type('dois');
    expect(submit().disabled).toBe(false);
    submit().click();
    fixture.detectChanges();
    expect(store.sendText.mock.calls).toEqual([['um'], ['dois']]);
  });

  it('gives the text back in front of what was typed meanwhile, and shows why', async () => {
    let fail: (value: typeof FAILURE) => void = () => undefined;
    store.sendText.mockImplementationOnce(
      () => new Promise<typeof FAILURE>((resolve) => (fail = resolve)),
    );
    type('primeiro');
    submit().click();
    type('segundo');
    fail(FAILURE);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('primeirosegundo');
    expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
  });

  it('does not give the text back when the result is uncertain (it may have been typed), and says so', async () => {
    store.sendText.mockResolvedValueOnce({
      kind: 'timeout',
      message: 'O PC não respondeu a tempo.',
    });
    type('minha senha');
    submit().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('');
    expect(root.querySelector('.error')?.textContent).toContain('O PC não respondeu a tempo.');
    expect(root.querySelector('.error')?.textContent).toContain('pode ter sido digitado');
  });

  it('gives back a text that a failure ahead in the queue cancelled and says it was not sent', async () => {
    store.sendText.mockResolvedValueOnce({ kind: 'cancelled', message: '' });
    type('def');
    submit().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('def');
    expect(root.querySelector('.error')?.textContent).toContain('O texto não foi enviado.');
  });

  it('gives back every text of a cancelled run, in the order they were sent', async () => {
    const resolvers: ((value: typeof FAILURE | { kind: 'cancelled'; message: string }) => void)[] =
      [];
    store.sendText.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve as never)),
    );
    type('abc');
    submit().click();
    type('def');
    submit().click();
    type('ghi');
    submit().click();
    resolvers[0]!(FAILURE);
    resolvers[1]!({ kind: 'cancelled', message: '' });
    resolvers[2]!({ kind: 'cancelled', message: '' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('abcdefghi');
    expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
  });

  it('keeps what the person typed after the texts that came back', async () => {
    const resolvers: ((value: typeof FAILURE) => void)[] = [];
    store.sendText.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    type('abc');
    submit().click();
    type('novo');
    resolvers[0]!(FAILURE);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('abcnovo');
  });

  it('treats a refusal of the PC system as uncertain too (part of the letters may have been typed)', async () => {
    store.sendText.mockResolvedValueOnce({
      kind: 'failed',
      message: 'O PC não executou o comando.',
    });
    type('abcdef');
    submit().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(field().value).toBe('');
    expect(root.querySelector('.error')?.textContent).toContain('pode ter sido digitado');
  });

  it('special keys send the key with no modifiers', () => {
    named('Enter').click();
    named('Apagar').click();
    named('Esc (Escape)').click();
    expect(store.sendKey.mock.calls).toEqual([
      ['ENTER', []],
      ['BACKSPACE', []],
      ['ESCAPE', []],
    ]);
  });

  it('has the four arrows', () => {
    for (const label of [
      'Seta para cima',
      'Seta para baixo',
      'Seta para a esquerda',
      'Seta para a direita',
    ]) {
      named(label).click();
    }
    expect(store.sendKey.mock.calls.map(([key]) => key)).toEqual(['UP', 'DOWN', 'LEFT', 'RIGHT']);
  });

  it('shortcuts send the key with its modifiers', () => {
    named('Copiar').click();
    named('Trocar Janela').click();
    named('Área de Trabalho').click();
    expect(store.sendKey.mock.calls).toEqual([
      ['C', ['CTRL']],
      ['TAB', ['ALT']],
      ['D', ['WIN']],
    ]);
  });

  it('is all disabled while the PC is not connected', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect(field().disabled).toBe(true);
    expect([...root.querySelectorAll<HTMLButtonElement>('button')].every((b) => b.disabled)).toBe(
      true,
    );
  });

  describe('armed modifiers', () => {
    const mod = (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('.mods button')].find(
        (b) => b.textContent?.trim() === name,
      )!;
    const armed = () =>
      [...root.querySelectorAll<HTMLButtonElement>('.mods button')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent?.trim());

    it('has Ctrl, Shift, Alt and Win as toggle buttons, none armed at first', () => {
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('.mods button')];
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Ctrl', 'Shift', 'Alt', 'Win']);
      expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
      expect(root.querySelector('.mods')?.getAttribute('aria-label')).toBe('Teclas armadas');
    });

    it('tapping arms it (shown pressed) and tapping again disarms it, sending nothing', () => {
      mod('Ctrl').click();
      fixture.detectChanges();
      expect(armed()).toEqual(['Ctrl']);
      expect(mod('Ctrl').classList.contains('armed')).toBe(true);
      mod('Ctrl').click();
      fixture.detectChanges();
      expect(armed()).toEqual([]);
      expect(store.sendKey).not.toHaveBeenCalled();
    });

    it('goes with the next key and disarms by itself', () => {
      mod('Ctrl').click();
      named('Enter').click();
      fixture.detectChanges();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('ENTER', ['CTRL']);
      expect(armed()).toEqual([]);
      named('Enter').click();
      expect(store.sendKey).toHaveBeenLastCalledWith('ENTER', []);
    });

    it('several can be armed at once and all go together, in the usual order', () => {
      mod('Alt').click();
      mod('Ctrl').click();
      mod('Shift').click();
      named('Del (Delete)').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('DELETE', ['CTRL', 'SHIFT', 'ALT']);
    });

    it('joins what a shortcut already has, without repeating a modifier', () => {
      mod('Shift').click();
      mod('Ctrl').click();
      named('Copiar').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('C', ['CTRL', 'SHIFT']);
    });

    it('Win armed goes with a function key', () => {
      mod('Win').click();
      named('F5').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('F5', ['WIN']);
    });

    it('a single letter typed in the field becomes the key (Ctrl armed and "c" is Ctrl+C)', async () => {
      mod('Ctrl').click();
      type('c');
      submit().click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('C', ['CTRL']);
      expect(store.sendText).not.toHaveBeenCalled();
      expect(field().value).toBe('');
      expect(armed()).toEqual([]);
    });

    it('longer text goes as text, and any send spends the armed modifiers', async () => {
      mod('Ctrl').click();
      mod('Shift').click();
      type('oi');
      submit().click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(store.sendText).toHaveBeenCalledExactlyOnceWith('oi');
      expect(store.sendKey).not.toHaveBeenCalled();
      expect(armed()).toEqual([]);
    });

    it('a failed send still spends them (it was attempted)', async () => {
      store.sendText.mockResolvedValueOnce(FAILURE);
      mod('Alt').click();
      type('oi');
      submit().click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(armed()).toEqual([]);
    });

    it('keeps them when the send never left: nothing to type, or no connection', () => {
      mod('Ctrl').click();
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      fixture.detectChanges();
      expect(store.sendText).not.toHaveBeenCalled();
      expect(armed()).toEqual(['Ctrl']);

      store.phase.set('offline');
      fixture.detectChanges();
      (fixture.componentInstance as unknown as { press(item: unknown): void }).press({
        key: 'ENTER',
      });
      expect(store.sendKey).not.toHaveBeenCalled();
      store.phase.set('ready');
      fixture.detectChanges();
      expect(armed()).toEqual(['Ctrl']);
      named('Enter').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('ENTER', ['CTRL']);
    });

    it('is disabled with the rest while the PC is not connected', () => {
      store.phase.set('offline');
      fixture.detectChanges();
      expect(
        [...root.querySelectorAll<HTMLButtonElement>('.mods button')].every((b) => b.disabled),
      ).toBe(true);
    });
  });

  it('has the function keys F1 to F12', () => {
    const labels = [...root.querySelectorAll<HTMLButtonElement>('.fkeys button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
    named('F11').click();
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('F11', []);
  });

  describe('text limit', () => {
    it('counts code points: 200 emoji go through whole, although they are 400 UTF-16 units', () => {
      const text = '😀'.repeat(200);
      type(text);
      expect(field().value).toBe(text);
      expect(submit().disabled).toBe(false);
    });

    it('never cuts an emoji in half at the limit', () => {
      type('a'.repeat(199) + '😀' + 'b');
      expect(field().value).toBe('a'.repeat(199) + '😀');
      type('a'.repeat(200) + '😀');
      expect(field().value).toBe('a'.repeat(200));
    });

    it('drops half an emoji left by a paste that the browser cut', () => {
      type('abc' + '😀'.slice(0, 1));
      expect(field().value).toBe('abc');
    });

    it('sends the whole text in one request, emoji and accents included', async () => {
      const text = 'olá 😀 ação';
      type(text);
      submit().click();
      await fixture.whenStable();
      expect(store.sendText).toHaveBeenCalledExactlyOnceWith(text);
    });
  });
});
