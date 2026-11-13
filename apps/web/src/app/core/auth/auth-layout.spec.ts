import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthLayout } from './auth-layout';

@Component({
  imports: [AuthLayout],
  template: `<app-auth-layout
    ><h1 i18n>Título</h1>
    <input id="campo"
  /></app-auth-layout>`,
})
class Host {}

@Component({
  imports: [AuthLayout],
  template: `<app-auth-layout
    ><h1 i18n>Título</h1>
    <form>
      <input id="campo" /><button type="submit" id="enviar" i18n>Enviar</button>
    </form></app-auth-layout
  >`,
})
class FormHost {}

@Component({
  imports: [AuthLayout],
  template: `<app-auth-layout
    ><h1 i18n>Título</h1>
    <input id="campo" /><button type="button" data-auth-submit i18n>
      Confirmar
    </button></app-auth-layout
  >`,
})
class MarkedHost {}

/** `visualViewport` falso: o jsdom não tem. */
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

describe('AuthLayout', () => {
  let viewport: FakeViewport;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    viewport = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'visualViewport');
  });

  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, input: root.querySelector<HTMLInputElement>('#campo')! };
  }
  const inset = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('app-auth-layout')!.style.getPropertyValue('--kb-inset');
  const resizeTo = (height: number, offsetTop = 0) => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event('resize'));
  };
  const boxAt = (top: number, bottom: number) =>
    vi
      .spyOn(HTMLInputElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top, bottom } as DOMRect);
  const focusField = (input: HTMLInputElement) => {
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  };

  it('shows the brand, projects the content and keeps a single main landmark', () => {
    const { root } = setup();
    expect(root.querySelectorAll('main')).toHaveLength(1);
    expect(root.querySelector('main h1')?.textContent).toBe('Título');
    expect(root.querySelector('.brand .name')?.textContent).toBe('UniOver');
    // A marca é só o símbolo e o nome do app, sem frase de efeito.
    expect(root.querySelector('.brand')?.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelector('.brand svg')?.getAttribute('aria-hidden')).toBe('true');
    // A marca não é um título: só o conteúdo projetado tem `h1`.
    expect(root.querySelectorAll('h1, h2')).toHaveLength(1);
  });

  it('leaves room at the bottom for the virtual keyboard, and none for small differences', () => {
    const { fixture, root } = setup();
    expect(inset(root)).toBe('0px');

    resizeTo(480); // teclado de 320 px
    fixture.detectChanges();
    expect(inset(root)).toBe('320px');

    resizeTo(740); // só a barra de endereço
    fixture.detectChanges();
    expect(inset(root)).toBe('0px');

    resizeTo(440, 40); // a parte visível rolou 40 px dentro da janela
    fixture.detectChanges();
    expect(inset(root)).toBe('320px');
  });

  it('scrolls a covered field into view once the keyboard settles', () => {
    const { input } = setup();
    boxAt(600, 648);
    resizeTo(420);
    focusField(input);
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('does not move the page when the field is already visible (desktop)', () => {
    const { input } = setup();
    boxAt(200, 248);
    focusField(input);
    vi.advanceTimersByTime(350);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('checks again when the visible area changes while a field has focus', () => {
    const { input } = setup();
    boxAt(300, 348);
    focusField(input);
    vi.advanceTimersByTime(350);
    expect(scrollIntoView).not.toHaveBeenCalled();
    resizeTo(330); // o teclado acabou de subir e cobriu o campo
    vi.advanceTimersByTime(150);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does not reveal again when the visible area only scrolls (its own smooth scroll included)', () => {
    const { fixture, root, input } = setup();
    boxAt(600, 648);
    resizeTo(420); // teclado aberto: o campo ficou atrás dele
    focusField(input);
    vi.advanceTimersByTime(350);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // A rolagem suave move a área visível várias vezes: só o espaço do teclado é atualizado.
    viewport.height = 420;
    for (const offsetTop of [10, 20, 30]) {
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('scroll'));
    }
    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(inset(root)).toBe('350px');
  });

  it('ignores a resize caused by its own scroll, and answers the keyboard afterwards', () => {
    const { input } = setup();
    boxAt(600, 648);
    resizeTo(420); // teclado aberto: o campo ficou atrás dele
    focusField(input);
    vi.advanceTimersByTime(350);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // A barra do navegador encolhe durante a rolagem que a moldura pediu: não é motivo para outra.
    resizeTo(460);
    vi.advanceTimersByTime(150);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // Passada a rolagem, o teclado mudando de altura volta a ser atendido.
    vi.advanceTimersByTime(600);
    resizeTo(400);
    vi.advanceTimersByTime(150);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  describe('with the submit button of the same form', () => {
    let scrollBy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollBy = vi.fn();
      window.scrollBy = scrollBy as unknown as Window['scrollBy'];
    });

    function setupForm(field: [number, number], button: [number, number]) {
      const fixture = TestBed.createComponent(FormHost);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: field[0],
        bottom: field[1],
      } as DOMRect);
      vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: button[0],
        bottom: button[1],
      } as DOMRect);
      return root.querySelector<HTMLInputElement>('#campo')!;
    }

    it('brings the button above the keyboard too, when field and button fit together', () => {
      const input = setupForm([200, 248], [300, 348]);
      resizeTo(340); // teclado cobre de 340 para baixo: o campo aparece, o botão não
      focusField(input);
      vi.advanceTimersByTime(350);
      // O fim do botão (348) vai para 340 - 24: rola 32 px, e o campo continua longe do topo.
      expect(scrollBy).toHaveBeenCalledWith({ top: 32, behavior: 'smooth' });
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('scrolls up when the field is above the visible part, keeping the button in view', () => {
      const input = setupForm([10, 58], [100, 148]);
      resizeTo(340);
      focusField(input);
      vi.advanceTimersByTime(350);
      expect(scrollBy).toHaveBeenCalledWith({ top: -14, behavior: 'smooth' });
    });

    it('uses the button marked as the submit on a screen without a form', () => {
      const fixture = TestBed.createComponent(MarkedHost);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        '#campo',
      )!;
      vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 200,
        bottom: 248,
      } as DOMRect);
      vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 300,
        bottom: 348,
      } as DOMRect);
      resizeTo(340);
      focusField(input);
      vi.advanceTimersByTime(350);
      expect(scrollBy).toHaveBeenCalledWith({ top: 32, behavior: 'smooth' });
    });

    it('centres the field alone when field and button do not fit together', () => {
      const input = setupForm([500, 548], [900, 948]);
      resizeTo(340);
      focusField(input);
      vi.advanceTimersByTime(350);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
      expect(scrollBy).not.toHaveBeenCalled();
    });

    it('does not move when field and button are both visible', () => {
      const input = setupForm([200, 248], [260, 308]);
      resizeTo(340);
      focusField(input);
      vi.advanceTimersByTime(350);
      expect(scrollBy).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  it('stops listening when destroyed', () => {
    const { fixture, root } = setup();
    fixture.destroy();
    resizeTo(400);
    expect(inset(root)).toBe('0px');
  });
});
