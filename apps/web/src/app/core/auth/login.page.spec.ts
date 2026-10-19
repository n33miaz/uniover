import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { LoginPage } from './login.page';

@Component({ template: '' })
class Blank {}

describe('LoginPage', () => {
  const api = { login: vi.fn(), refresh: vi.fn(), me: vi.fn() };
  let harness: RouterTestingHarness;

  beforeEach(() => {
    api.login.mockReset();
    api.refresh.mockReset().mockRejectedValue(new ApiProblem(401, '', 'x'));
    api.me.mockReset().mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'A' });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: LoginPage },
          { path: 'tv', component: Blank },
          { path: '', component: Blank },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  async function render(url = '/entrar') {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    return harness.routeNativeElement as HTMLElement;
  }

  const field = (el: HTMLElement, id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
  async function fillAndSubmit(
    el: HTMLElement,
    email = 'dono@exemplo.com',
    password = 'senha-boa',
  ) {
    const emailField = field(el, 'login-email');
    emailField.value = email;
    emailField.dispatchEvent(new Event('input'));
    const passwordField = field(el, 'login-password');
    passwordField.value = password;
    passwordField.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await harness.fixture.whenStable();
  }
  const text = (el: HTMLElement) =>
    el.querySelector('.messages')?.textContent?.replace(/\s+/g, ' ').trim();

  it('has labeled fields with the right autocomplete hints and focuses the e-mail field', async () => {
    const el = await render();
    expect(el.querySelector('label[for="login-email"]')?.textContent).toBe('E-mail');
    expect(el.querySelector('label[for="login-password"]')?.textContent).toBe('Senha');
    expect(field(el, 'login-email').autocomplete).toBe('username');
    expect(field(el, 'login-password').autocomplete).toBe('current-password');
    expect(field(el, 'login-password').type).toBe('password');
    expect(document.activeElement).toBe(field(el, 'login-email'));
  });

  it('shows and hides the password', async () => {
    const el = await render();
    const toggle = el.querySelector<HTMLButtonElement>('.toggle')!;
    toggle.click();
    harness.fixture.detectChanges();
    expect(field(el, 'login-password').type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    harness.fixture.detectChanges();
    expect(field(el, 'login-password').type).toBe('password');
  });

  it('signs in and goes home', async () => {
    api.login.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render();
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/'));
    expect(api.login).toHaveBeenCalledWith('dono@exemplo.com', 'senha-boa');
    expect(TestBed.inject(SessionState).status()).toBe('authenticated');
  });

  it('goes back to a safe next path', async () => {
    api.login.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render('/entrar?next=%2Ftv');
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'));
  });

  it.each([
    ['//evil.com', '%2F%2Fevil.com'],
    ['an absolute URL', 'https%3A%2F%2Fevil.com'],
    ['a backslash path', '%2F%5Cevil.com'],
  ])('ignores a malicious next (%s) and goes home', async (_label, encoded) => {
    api.login.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render(`/entrar?next=${encoded}`);
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/'));
  });

  it('shows one generic message for a wrong e-mail or password', async () => {
    api.login.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const el = await render();
    await fillAndSubmit(el);
    expect(text(el)).toBe('E-mail ou senha inválidos.');
    expect(el.querySelector('.error')?.getAttribute('role')).toBe('alert');
    expect(TestBed.inject(Router).url).toBe('/entrar');
  });

  it('moves focus to the error message', async () => {
    api.login.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const el = await render();
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(document.activeElement).toBe(el.querySelector('.error')));
  });

  it('keeps the submit button disabled and labelled while signing in', async () => {
    let finish!: (value: unknown) => void;
    api.login.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const el = await render();
    await vi.waitFor(() => expect(el.querySelector('form')).toBeTruthy());
    const emailField = field(el, 'login-email');
    emailField.value = 'a@b.c';
    emailField.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    harness.fixture.detectChanges();
    const submit = el.querySelector<HTMLButtonElement>('.submit')!;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent?.trim()).toBe('Entrando…');
    finish({ accessToken: 't', expiresIn: 600 });
    await harness.fixture.whenStable();
  });

  it('explains a locked account with a countdown that blocks new attempts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.login.mockRejectedValue(new ApiProblem(429, 'login-locked', 'x', null, null, 3));
    const el = await render();
    await fillAndSubmit(el);
    harness.fixture.detectChanges();
    expect(text(el)).toContain('Conta bloqueada');
    expect(text(el)).toContain('Tente de novo em 3 s.');
    expect(el.querySelector<HTMLButtonElement>('.submit')!.disabled).toBe(true);
    const calls = api.login.mock.calls.length;
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(api.login.mock.calls.length).toBe(calls);

    await vi.advanceTimersByTimeAsync(1_000);
    harness.fixture.detectChanges();
    expect(text(el)).toContain('Tente de novo em 2 s.');
    await vi.advanceTimersByTimeAsync(2_000);
    harness.fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('.submit')!.disabled).toBe(false);
  });

  it('explains the generic rate limit (429 without the lock type)', async () => {
    api.login.mockRejectedValue(new ApiProblem(429, 'rate-limited', 'x', null, null, 30));
    const el = await render();
    await fillAndSubmit(el);
    expect(text(el)).toContain('Muitas tentativas seguidas');
  });

  it.each([
    ['a 400', new ApiProblem(400, 'validation-failed', 'x'), 'Confira o e-mail e a senha'],
    ['no network', networkProblem(), 'Sem conexão com o servidor'],
    ['a server error', new ApiProblem(500, '', 'x'), 'Não foi possível entrar agora'],
  ])('shows a clear message for %s', async (_label, error, expected) => {
    api.login.mockRejectedValue(error);
    const el = await render();
    await fillAndSubmit(el);
    expect(text(el)).toContain(expected);
  });

  it('skips the form for someone whose refresh cookie is still valid', async () => {
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    await render('/entrar?next=%2Ftv');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'));
  });
});
