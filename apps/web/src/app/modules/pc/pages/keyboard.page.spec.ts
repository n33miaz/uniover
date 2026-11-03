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

  it('has a labelled field, limited to what the contract accepts', () => {
    expect(root.querySelector('label[for=pc-text]')).not.toBeNull();
    expect(field().maxLength).toBe(200);
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
});
