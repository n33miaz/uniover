import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthNotice } from './auth-notice';
import { AuthState } from './auth-state';

@Component({
  imports: [AuthNotice, AuthState],
  template: `
    <app-auth-notice
      [tone]="'warn'"
      [role]="'alert'"
      [icon]="'lock'"
      [heading]="'Conta bloqueada'"
      [detail]="'Espere um pouco.'"
      [countdown]="{ label: '0:42', words: '42 segundos', total: 42 }"
    />
    <app-auth-notice [tone]="'ok'" [role]="'status'" [heading]="'Pronto'" />
    <app-auth-state
      [tone]="'bad'"
      [icon]="'mail-off'"
      [role]="'alert'"
      heading="Este convite não vale mais"
      i18n-heading
      detail="Ele já foi usado."
      i18n-detail
      advice="Peça um novo link."
      i18n-advice
    >
      <a href="/entrar" i18n>entrar</a>
    </app-auth-state>
  `,
})
class Host {}

describe('AuthNotice', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('carries the role and tone on the element itself and can be focused', () => {
    const [alert, status] = Array.from(setup().querySelectorAll<HTMLElement>('app-auth-notice'));
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.dataset['tone']).toBe('warn');
    expect(alert.querySelector('.heading')?.textContent).toBe('Conta bloqueada');
    expect(alert.querySelector('.detail')?.textContent).toBe('Espere um pouco.');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.querySelector('.detail')).toBeNull();
    alert.focus();
    expect(document.activeElement).toBe(alert);
  });

  it('keeps the moving countdown out of the reader and says the wait once, in words', () => {
    const alert = setup().querySelector('app-auth-notice')!;
    const wait = alert.querySelector('.wait')!;
    expect(wait.getAttribute('aria-hidden')).toBe('true');
    expect(wait.querySelector('.wait-time')?.textContent).toBe('0:42');
    expect(alert.querySelector('.ui-visually-hidden')?.textContent).toContain('42 segundos');
    expect(alert.querySelector('.bar')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('AuthState', () => {
  it('shows icon, the only heading, the explanation, the advice and the projected actions', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const state = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      'app-auth-state',
    )!;
    expect(state.dataset['tone']).toBe('bad');
    expect(state.querySelector('h1')?.textContent).toBe('Este convite não vale mais');
    expect(state.querySelector('[role="alert"] .detail')?.textContent).toBe('Ele já foi usado.');
    expect(state.querySelector('.advice')?.textContent).toBe('Peça um novo link.');
    expect(state.querySelector('.actions a')?.getAttribute('href')).toBe('/entrar');
    expect(state.querySelector('.mark')?.getAttribute('aria-hidden')).toBe('true');
  });
});
