import { coveredByKeyboard, watchKeyboardInset } from './keyboard-inset';

describe('coveredByKeyboard', () => {
  it('devolve 0 quando só a barra do navegador mexeu na janela', () => {
    expect(coveredByKeyboard(664, { height: 620, offsetTop: 0 })).toBe(0);
  });

  it('devolve a altura coberta quando o teclado abre', () => {
    expect(coveredByKeyboard(664, { height: 380, offsetTop: 0 })).toBe(284);
  });

  it('desconta a rolagem da área visível', () => {
    expect(coveredByKeyboard(664, { height: 380, offsetTop: 100 })).toBe(184);
  });
});

describe('watchKeyboardInset', () => {
  it('põe e atualiza --kb-inset na raiz e limpa ao parar', () => {
    const target = new EventTarget();
    const viewport = Object.assign(target, { height: 664, offsetTop: 0 });
    const win = { innerHeight: 664, visualViewport: viewport } as unknown as Window;
    const root = document.createElement('div');

    const stop = watchKeyboardInset(win, root);
    expect(root.style.getPropertyValue('--kb-inset')).toBe('0px');

    viewport.height = 380;
    target.dispatchEvent(new Event('resize'));
    expect(root.style.getPropertyValue('--kb-inset')).toBe('284px');

    stop();
    expect(root.style.getPropertyValue('--kb-inset')).toBe('');
  });

  it('não faz nada sem visualViewport', () => {
    const stop = watchKeyboardInset(
      { innerHeight: 600 } as unknown as Window,
      document.createElement('div'),
    );
    expect(stop).not.toThrow();
  });
});
