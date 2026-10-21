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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(url = '/entrar') {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    return harness.routeNativeElement as HTMLElement;
  }

  const field = (el: HTMLElement, id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
  const type = (el: HTMLElement, id: string, value: string) => {
    const input = field(el, id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submitForm = async (el: HTMLElement) => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
  };
  async function fillAndSubmit(
    el: HTMLElement,
    email = 'dono@exemplo.com',
    password = 'senha-boa',
  ) {
    type(el, 'login-email', email);
    type(el, 'login-password', password);
    await submitForm(el);
  }
  const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim();
  const text = (el: HTMLElement, selector = '.messages') =>
    clean(el.querySelector(selector)?.textContent);
  const submitButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.submit')!;
  const notice = (el: HTMLElement) => el.querySelector<HTMLElement>('app-auth-notice');

  it('has labeled fields with the right autocomplete and keyboard hints, inside the shared frame', async () => {
    const el = await render();
    expect(el.querySelector('app-auth-layout main')).not.toBeNull();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('label[for="login-email"]')?.textContent).toBe('E-mail');
    expect(el.querySelector('label[for="login-password"]')?.textContent).toBe('Senha');
    const email = field(el, 'login-email');
    const password = field(el, 'login-password');
    expect(email.autocomplete).toBe('username');
    expect(email.type).toBe('email');
    expect(email.getAttribute('inputmode')).toBe('email');
    expect(email.getAttribute('autocapitalize')).toBe('none');
    expect(email.getAttribute('autocorrect')).toBe('off');
    expect(email.spellcheck).toBe(false);
    expect(email.getAttribute('enterkeyhint')).toBe('next');
    expect(password.autocomplete).toBe('current-password');
    expect(password.type).toBe('password');
    expect(password.getAttribute('enterkeyhint')).toBe('go');
    // Nada de "esqueci a senha" nem de "lembrar de mim": não existem neste sistema.
    expect(el.textContent).not.toMatch(/esqueci|recuper|lembrar/i);
  });

  it('focuses the e-mail field on a mouse device', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const el = await render();
    expect(document.activeElement).toBe(field(el, 'login-email'));
  });

  it('never steals focus on a touch screen (the keyboard would cover the page before it is read)', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const el = await render();
    expect(document.activeElement).not.toBe(field(el, 'login-email'));
  });

  it('presses the submit button without taking focus from the field (so a warning cannot move it under the finger)', async () => {
    const el = await render();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    submitButton(el).dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('shows and hides the password with an accessible toggle', async () => {
    const el = await render();
    const toggle = el.querySelector<HTMLButtonElement>('.toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Mostrar senha');
    toggle.click();
    harness.fixture.detectChanges();
    expect(field(el, 'login-password').type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    harness.fixture.detectChanges();
    expect(field(el, 'login-password').type).toBe('password');
  });

  it('signs in, clears the password and goes home', async () => {
    api.login.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render();
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/'));
    expect(api.login).toHaveBeenCalledWith('dono@exemplo.com', 'senha-boa');
    expect(TestBed.inject(SessionState).status()).toBe('authenticated');
  });

  it('trims the e-mail before sending', async () => {
    api.login.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render();
    await fillAndSubmit(el, '  dono@exemplo.com ');
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledWith('dono@exemplo.com', 'senha-boa'));
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

  describe('validation', () => {
    it('does not scold while typing: a field only complains after losing focus', async () => {
      const el = await render();
      type(el, 'login-email', 'ana');
      harness.fixture.detectChanges();
      expect(el.querySelector('.error')).toBeNull();
      expect(field(el, 'login-email').hasAttribute('aria-invalid')).toBe(false);

      field(el, 'login-email').dispatchEvent(new Event('blur'));
      harness.fixture.detectChanges();
      expect(text(el, '#login-email-error')).toContain('Confira o e-mail');
      expect(field(el, 'login-email').getAttribute('aria-invalid')).toBe('true');
      expect(field(el, 'login-email').getAttribute('aria-describedby')).toBe('login-email-error');

      // Corrigir limpa o aviso na hora.
      type(el, 'login-email', 'ana@exemplo.com');
      harness.fixture.detectChanges();
      expect(el.querySelector('#login-email-error')).toBeNull();
    });

    it('an empty submit calls nothing, explains both fields and focuses the first invalid one', async () => {
      const el = await render();
      await submitForm(el);
      expect(api.login).not.toHaveBeenCalled();
      expect(text(el, '#login-email-error')).toBe('Informe o seu e-mail.');
      expect(text(el, '#login-password-error')).toBe('Informe a sua senha.');
      expect(document.activeElement).toBe(field(el, 'login-email'));
      // Sem faixa de erro: o aviso está em cada campo.
      expect(notice(el)).toBeNull();

      type(el, 'login-email', 'ana@exemplo.com');
      await submitForm(el);
      expect(document.activeElement).toBe(field(el, 'login-password'));
      expect(api.login).not.toHaveBeenCalled();
    });

    it('never disables the button just because a field is empty (it leads to the explanation)', async () => {
      const el = await render();
      expect(submitButton(el).disabled).toBe(false);
    });
  });

  describe('Caps Lock', () => {
    it('warns while the password field has Caps Lock on, and the warning is not an alert', async () => {
      const el = await render();
      const password = field(el, 'login-password');
      const key = new KeyboardEvent('keydown', { key: 'A', bubbles: true });
      key.getModifierState = (modifier: string) => modifier === 'CapsLock';
      password.dispatchEvent(key);
      harness.fixture.detectChanges();
      // A segunda região é a da senha (a primeira é a do e-mail, que nunca avisa).
      const region = el.querySelectorAll('.caps-slot')[1];
      expect(clean(region.textContent)).toContain('Caps Lock ligado');
      expect(region.getAttribute('role')).toBe('status');
      expect(notice(el)).toBeNull();
    });
  });

  describe('errors', () => {
    it('shows one generic message for a wrong e-mail or password, in an alert that takes focus', async () => {
      api.login.mockRejectedValue(new ApiProblem(401, '', 'x'));
      const el = await render();
      await fillAndSubmit(el);
      expect(text(el)).toContain('E-mail ou senha incorretos.');
      expect(notice(el)?.getAttribute('role')).toBe('alert');
      expect(TestBed.inject(Router).url).toBe('/entrar');
      await vi.waitFor(() => expect(document.activeElement).toBe(notice(el)));
      // Os campos não dizem qual dos dois errou.
      expect(field(el, 'login-email').hasAttribute('aria-invalid')).toBe(false);
      expect(field(el, 'login-password').hasAttribute('aria-invalid')).toBe(false);
    });

    it('keeps what was typed after a refusal', async () => {
      api.login.mockRejectedValue(new ApiProblem(401, '', 'x'));
      const el = await render();
      await fillAndSubmit(el);
      expect(field(el, 'login-email').value).toBe('dono@exemplo.com');
      expect(field(el, 'login-password').value).toBe('senha-boa');
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
      expect(notice(el)?.getAttribute('role')).toBe('alert');
    });

    it('explains the generic rate limit (429 without the lock type) without a countdown when the server gives no time', async () => {
      api.login.mockRejectedValue(new ApiProblem(429, 'rate-limited', 'x'));
      const el = await render();
      await fillAndSubmit(el);
      expect(text(el)).toContain('Muitas tentativas seguidas');
      expect(el.querySelector('.wait')).toBeNull();
      expect(submitButton(el).disabled).toBe(false);
    });
  });

  describe('sending', () => {
    it('keeps the button disabled, with a spinner and the same label slot, while signing in', async () => {
      let finish!: (value: unknown) => void;
      api.login.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const el = await render();
      type(el, 'login-email', 'a@b.c');
      type(el, 'login-password', 'senha-boa');
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      harness.fixture.detectChanges();
      const submit = submitButton(el);
      expect(submit.disabled).toBe(true);
      expect(submit.textContent?.trim()).toBe('Entrando…');
      expect(submit.querySelector('.ui-spinner')?.getAttribute('aria-hidden')).toBe('true');

      // Um segundo envio no meio do primeiro não vai ao servidor.
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(api.login).toHaveBeenCalledTimes(1);

      finish({ accessToken: 't', expiresIn: 600 });
      await harness.fixture.whenStable();
    });
  });

  describe('lockout', () => {
    // Só o relógio e o intervalo são falsos: o resto (promessas, renderização) segue real.
    const fakeClock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

    it('explains a locked account, counts down and blocks new attempts', async () => {
      fakeClock();
      api.login.mockRejectedValue(new ApiProblem(429, 'login-locked', 'x', null, null, 3));
      const el = await render();
      await fillAndSubmit(el);
      expect(text(el)).toContain('Conta bloqueada');
      expect(text(el, '.wait-time')).toBe('0:03');
      // O leitor de tela ouve a espera uma vez, em palavras; o número que anda fica fora da leitura.
      expect(el.querySelector('.wait')?.getAttribute('aria-hidden')).toBe('true');
      expect(text(el, 'app-auth-notice .ui-visually-hidden')).toBe('Tente de novo em 3 segundos.');
      expect(submitButton(el).disabled).toBe(true);
      const calls = api.login.mock.calls.length;
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(api.login.mock.calls.length).toBe(calls);

      await vi.advanceTimersByTimeAsync(1_000);
      harness.fixture.detectChanges();
      expect(text(el, '.wait-time')).toBe('0:02');
      // Nada de reanunciar a cada segundo: o texto lido não muda.
      expect(text(el, 'app-auth-notice .ui-visually-hidden')).toBe('Tente de novo em 3 segundos.');
    });

    it('turns the lock message into a calm "ready" status by itself when the wait is over', async () => {
      fakeClock();
      api.login.mockRejectedValue(new ApiProblem(429, 'login-locked', 'x', null, null, 2));
      const el = await render();
      await fillAndSubmit(el);
      expect(notice(el)?.getAttribute('role')).toBe('alert');

      await vi.advanceTimersByTimeAsync(2_000);
      harness.fixture.detectChanges();
      expect(submitButton(el).disabled).toBe(false);
      expect(notice(el)?.getAttribute('role')).toBe('status');
      expect(notice(el)?.dataset['tone']).toBe('ok');
      expect(text(el)).toContain('Pronto, você já pode tentar de novo.');
      expect(text(el)).not.toContain('Conta bloqueada');
      expect(el.querySelector('.wait')).toBeNull();
    });

    it('lets the user try again after the wait and clears the old message on the next attempt', async () => {
      fakeClock();
      api.login.mockRejectedValueOnce(new ApiProblem(429, 'login-locked', 'x', null, null, 1));
      api.login.mockResolvedValueOnce({ accessToken: 't', expiresIn: 600 });
      const el = await render();
      await fillAndSubmit(el);
      await vi.advanceTimersByTimeAsync(1_000);
      harness.fixture.detectChanges();
      await submitForm(el);
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/'));
      expect(api.login).toHaveBeenCalledTimes(2);
    });
  });

  it('skips the form for someone whose refresh cookie is still valid', async () => {
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    await render('/entrar?next=%2Ftv');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'));
  });
});
