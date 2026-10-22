import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthField } from './auth-field';

@Component({
  imports: [AuthField],
  template: `
    <app-auth-field
      #field
      [fieldId]="'f'"
      [name]="'password'"
      label="Senha"
      i18n-label
      [kind]="kind()"
      [maxChars]="limit()"
      [autocomplete]="'current-password'"
      [enterKeyHint]="'go'"
      toggleLabel="Mostrar senha"
      i18n-toggleLabel
      [error]="error()"
      [invalid]="invalid()"
      [describedBy]="'extra'"
      [(value)]="value"
      (blurred)="blurs.set(blurs() + 1)"
    >
      <p id="extra" i18n>dica</p>
    </app-auth-field>
  `,
})
class Host {
  readonly field = viewChild.required<AuthField>('field');
  readonly kind = signal<'email' | 'password' | 'text'>('password');
  readonly limit = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly invalid = signal(false);
  readonly value = signal('');
  readonly blurs = signal(0);
}

describe('AuthField', () => {
  function setup(kind: 'email' | 'password' | 'text' = 'password') {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.kind.set(kind);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input')!;
    return { fixture, host: fixture.componentInstance, el, input };
  }
  const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.toggle')!;
  const capsKey = (input: HTMLInputElement, on: boolean, type = 'keydown') => {
    const event = new KeyboardEvent(type, { key: 'a', bubbles: true });
    event.getModifierState = (modifier: string) => modifier === 'CapsLock' && on;
    input.dispatchEvent(event);
  };

  it('ties a visible label to the input and sets every keyboard and autofill hint', () => {
    const { el, input } = setup();
    expect(el.querySelector('label')?.textContent).toBe('Senha');
    expect(el.querySelector('label')?.getAttribute('for')).toBe('f');
    expect(input.id).toBe('f');
    expect(input.name).toBe('password');
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.spellcheck).toBe(false);
    expect(input.getAttribute('enterkeyhint')).toBe('go');
    expect(input.getAttribute('maxlength')).toBe('256');
    expect(input.required).toBe(true);
    expect(input.hasAttribute('inputmode')).toBe(false);
  });

  it('is an e-mail field without toggle: e-mail keyboard and the API length limit', () => {
    const { el, input } = setup('email');
    expect(input.type).toBe('email');
    expect(input.getAttribute('inputmode')).toBe('email');
    expect(input.getAttribute('maxlength')).toBe('254');
    expect(toggle(el)).toBeNull();
  });

  it('shows and hides the password with a toggle that keeps the focus in the field', () => {
    const { fixture, el, input } = setup();
    const button = toggle(el);
    expect(button.getAttribute('aria-label')).toBe('Mostrar senha');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    button.click();
    fixture.detectChanges();
    expect(input.type).toBe('text');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click();
    fixture.detectChanges();
    expect(input.type).toBe('password');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('writes what is typed back through the two-way value', () => {
    const { fixture, host, input } = setup();
    input.value = 'segredo';
    input.dispatchEvent(new Event('input'));
    expect(host.value()).toBe('segredo');
    host.value.set('outro');
    fixture.detectChanges();
    expect(input.value).toBe('outro');
  });

  it('links the error (first) and the extra description to the field and marks it invalid', () => {
    const { fixture, host, el, input } = setup();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.getAttribute('aria-describedby')).toBe('extra');

    host.error.set('Informe a sua senha.');
    fixture.detectChanges();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('f-error extra');
    expect(el.querySelector('#f-error')?.textContent).toContain('Informe a sua senha.');

    host.error.set(null);
    host.invalid.set(true);
    fixture.detectChanges();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('extra');
    expect(el.querySelector('#f-error')).toBeNull();
  });

  it('warns about Caps Lock in a polite status region (never an alert), only while focused', () => {
    const { fixture, el, input } = setup();
    const region = el.querySelector('.caps-slot')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');

    capsKey(input, true);
    fixture.detectChanges();
    expect(region.textContent).toContain('Caps Lock ligado');
    expect(el.querySelector('[role="alert"]')).toBeNull();

    capsKey(input, false, 'keyup');
    fixture.detectChanges();
    expect(region.textContent?.trim()).toBe('');

    capsKey(input, true);
    fixture.detectChanges();
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(region.textContent?.trim()).toBe('');
  });

  it('does not warn about Caps Lock on an e-mail field', () => {
    const { fixture, el, input } = setup('email');
    capsKey(input, true);
    fixture.detectChanges();
    expect(el.querySelector('.caps')).toBeNull();
  });

  it('tells the owner when the field loses focus', () => {
    const { host, input } = setup();
    input.dispatchEvent(new Event('blur'));
    expect(host.blurs()).toBe(1);
  });

  it('focuses and can select the content, so a refused e-mail is quick to retype', () => {
    const { fixture, host, input } = setup();
    host.value.set('segredo-antigo');
    fixture.detectChanges();
    host.field().focus(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('segredo-antigo'.length);
  });

  it('knows whether the cursor is already in the field', () => {
    const { host, input } = setup();
    expect(host.field().isFocused()).toBe(false);
    host.field().focus();
    expect(host.field().isFocused()).toBe(true);
    input.blur();
    expect(host.field().isFocused()).toBe(false);
  });

  describe('free text (a name)', () => {
    it('is a plain text field: no e-mail keyboard, words capitalized, no spelling squiggles', () => {
      const { input } = setup('text');
      expect(input.type).toBe('text');
      expect(input.getAttribute('inputmode')).toBeNull();
      expect(input.getAttribute('autocapitalize')).toBe('words');
      expect(input.getAttribute('autocorrect')).toBe('off');
      expect(input.spellcheck).toBe(false);
    });

    it('has no show-password button and no Caps Lock warning', () => {
      const { fixture, el, input } = setup('text');
      expect(toggle(el)).toBeNull();
      capsKey(input, true);
      fixture.detectChanges();
      expect(el.querySelector('.caps')).toBeNull();
    });

    it('takes the typing limit from the owner, and falls back to the e-mail limit without one', () => {
      const { fixture, host, input } = setup('text');
      expect(input.getAttribute('maxlength')).toBe('254');
      host.limit.set(120);
      fixture.detectChanges();
      expect(input.getAttribute('maxlength')).toBe('120');
    });

    it('keeps the e-mail and password hints exactly as they were', () => {
      const { fixture, host, input } = setup('email');
      expect(input.type).toBe('email');
      expect(input.getAttribute('inputmode')).toBe('email');
      expect(input.getAttribute('autocapitalize')).toBe('none');
      host.kind.set('password');
      fixture.detectChanges();
      expect(input.getAttribute('autocapitalize')).toBe('none');
      expect(input.getAttribute('inputmode')).toBeNull();
    });
  });
});
