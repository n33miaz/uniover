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

  it('stops listening when destroyed', () => {
    const { fixture, root } = setup();
    fixture.destroy();
    resizeTo(400);
    expect(inset(root)).toBe('0px');
  });
});
