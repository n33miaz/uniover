import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authGuard } from './auth.guard';
import { WelcomePage } from './welcome.page';

@Component({ template: '' })
class Blank {}

describe('WelcomePage', () => {
  const api = { refresh: vi.fn(), me: vi.fn(), updateMe: vi.fn() };
  const unconfirmed = {
    id: '1',
    email: 'ana@exemplo.com',
    displayName: 'ana',
    role: 'owner',
    displayNameConfirmed: false,
    permissions: [],
  };
  const confirmed = (name: string) => ({
    ...unconfirmed,
    displayName: name,
    displayNameConfirmed: true,
  });
  const problem = (status: number, fieldErrors = {}, retryAfter: number | null = null) =>
    new ApiProblem(status, '', 'x', null, null, retryAfter, fieldErrors);

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(unconfirmed);
    api.updateMe
      .mockReset()
      .mockImplementation(async (_token: string, name: string) => confirmed(name));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          // Como no app: o guarda de entrada já confirmou a sessão (e leu o usuário) antes de a tela nascer.
          { path: 'boas-vindas', component: WelcomePage, canMatch: [authGuard] },
          { path: 'ajustes', component: Blank },
          { path: 'tv', component: Blank },
          { path: '', pathMatch: 'full', component: Blank },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  async function open(url = '/boas-vindas') {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    harness.detectChanges();
    const el = harness.routeNativeElement as HTMLElement;
    return { harness, el };
  }

  const field = (el: HTMLElement) => el.querySelector<HTMLInputElement>('#welcome-name')!;
  const submitButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.submit')!;
  const type = (el: HTMLElement, value: string) => {
    const input = field(el);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = async (harness: RouterTestingHarness, el: HTMLElement) => {
    submitButton(el).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const router = () => TestBed.inject(Router);

  it('asks how to call the person, with the name of the account already in the field', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toBe('Como devemos te chamar?');
    expect(field(el).value).toBe('ana');
    expect(el.querySelector('label')?.textContent).toBe('Seu nome');
    expect(submitButton(el).textContent?.trim()).toBe('Continuar');
    // A pergunta basta: nada de texto de apoio entre ela e o campo.
    expect(el.querySelector('h1 + *')?.tagName).toBe('FORM');
  });

  it('says honestly that the name can be changed later, in Ajustes', async () => {
    const { el } = await open();
    expect(el.querySelector('#welcome-name-hint')?.textContent?.trim()).toBe(
      'Dá para mudar depois, em Ajustes.',
    );
  });

  it('is the same identity as the sign-in: brand, card and the shared field', async () => {
    const { el } = await open();
    expect(el.querySelector('app-auth-layout .brand .mark')).not.toBeNull();
    expect(el.querySelector('app-auth-field')).not.toBeNull();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
  });

  it('configures the field for a name: no e-mail hints, words capitalized, a roomy typing limit', async () => {
    const { el } = await open();
    const input = field(el);
    expect(input.type).toBe('text');
    expect(input.getAttribute('autocomplete')).toBe('nickname');
    expect(input.getAttribute('autocapitalize')).toBe('words');
    expect(input.getAttribute('inputmode')).toBeNull();
    expect(input.getAttribute('maxlength')).toBe('120');
    expect(input.getAttribute('enterkeyhint')).toBe('go');
    // Dica e contador descrevem o campo para o leitor de tela (lidos ao focar, não a cada tecla).
    expect(input.getAttribute('aria-describedby')).toBe('welcome-name-hint welcome-name-counter');
  });

  it('counts the characters as the API does and updates while typing', async () => {
    const { harness, el } = await open();
    const counter = () => el.querySelector('#welcome-name-counter')?.textContent?.trim();
    expect(counter()).toBe('3 de 60');
    type(el, '  Ana   Maria ');
    harness.detectChanges();
    expect(counter()).toBe('9 de 60');
    type(el, 'Ana \u{1F600}');
    harness.detectChanges();
    expect(counter()).toBe('5 de 60');
  });

  it('saves the cleaned name and goes back to where the person was heading', async () => {
    const { harness, el } = await open('/boas-vindas?next=%2Fajustes');
    type(el, '  Ana   Maria ');
    await submit(harness, el);
    expect(api.updateMe).toHaveBeenCalledWith('t', 'Ana Maria');
    expect(router().url).toBe('/ajustes');
    // O nome novo é o da sessão (a saudação da Início muda sem recarregar) e a pergunta acabou.
    expect(TestBed.inject(SessionState).user()?.displayName).toBe('Ana Maria');
    expect(TestBed.inject(SessionState).needsWelcome()).toBe(false);
  });

  it('accepts the name the account already has with one tap', async () => {
    const { harness, el } = await open();
    await submit(harness, el);
    expect(api.updateMe).toHaveBeenCalledWith('t', 'ana');
    expect(router().url).toBe('/');
  });

  it.each([
    ['an address of another origin', '%2F%2Fevil.example'],
    ['the question itself', '%2Fboas-vindas'],
    ['the sign-in page', '%2Fentrar'],
  ])('ignores %s as the place to go back to', async (_label, next) => {
    const { harness, el } = await open(`/boas-vindas?next=${next}`);
    await submit(harness, el);
    expect(router().url).toBe('/');
  });

  describe('gentle validation', () => {
    it('does not scold before the person leaves the field or sends', async () => {
      const { harness, el } = await open();
      type(el, '');
      harness.detectChanges();
      expect(el.querySelector('.error')).toBeNull();
      expect(field(el).getAttribute('aria-invalid')).toBeNull();
    });

    it('an empty name is explained after leaving the field, linked to it, and nothing is sent', async () => {
      const { harness, el } = await open();
      type(el, '   ');
      field(el).dispatchEvent(new Event('blur'));
      harness.detectChanges();
      expect(el.querySelector('.error')?.textContent).toContain('Escreva como devemos te chamar.');
      expect(field(el).getAttribute('aria-invalid')).toBe('true');
      expect(field(el).getAttribute('aria-describedby')).toContain('welcome-name-error');
      await submit(harness, el);
      expect(api.updateMe).not.toHaveBeenCalled();
    });

    it('sending an empty name moves the focus to the field instead of disabling the button', async () => {
      const { harness, el } = await open();
      type(el, '');
      expect(submitButton(el).disabled).toBe(false);
      document.body.append(el);
      await submit(harness, el);
      expect(el.querySelector('.error')).not.toBeNull();
      expect(document.activeElement).toBe(field(el));
      el.remove();
    });

    it('a name past the limit is flagged right away (the counter already shows it) and is not sent', async () => {
      const { harness, el } = await open();
      type(el, 'a'.repeat(61));
      harness.detectChanges();
      expect(el.querySelector('.counter')?.classList.contains('over')).toBe(true);
      expect(el.querySelector('.error')?.textContent).toContain('até 60 caracteres');
      await submit(harness, el);
      expect(api.updateMe).not.toHaveBeenCalled();
    });

    it('exactly 60 characters is fine', async () => {
      const { harness, el } = await open();
      type(el, 'a'.repeat(60));
      await submit(harness, el);
      expect(api.updateMe).toHaveBeenCalledWith('t', 'a'.repeat(60));
    });
  });

  describe('when saving fails', () => {
    it('shows the message the API gave for the name, on the field, and stays', async () => {
      api.updateMe.mockRejectedValue(
        problem(400, { displayName: ['Use só letras, números, espaços e emojis comuns.'] }),
      );
      const { harness, el } = await open();
      await submit(harness, el);
      expect(el.querySelector('.error')?.textContent).toContain(
        'Use só letras, números, espaços e emojis comuns.',
      );
      expect(field(el).getAttribute('aria-invalid')).toBe('true');
      expect(router().url).toBe('/boas-vindas');
      expect(TestBed.inject(SessionState).needsWelcome()).toBe(true);
    });

    it('clears the message from the API as soon as the person edits the name', async () => {
      api.updateMe.mockRejectedValueOnce(problem(400, { displayName: ['Informe seu nome.'] }));
      const { harness, el } = await open();
      await submit(harness, el);
      expect(el.querySelector('.error')).not.toBeNull();
      type(el, 'Ana');
      harness.detectChanges();
      expect(el.querySelector('.error')).toBeNull();
    });

    it('no connection: warns, keeps the name, never navigates, and lets the person try again', async () => {
      api.updateMe.mockRejectedValueOnce(networkProblem());
      const { harness, el } = await open('/boas-vindas?next=%2Ftv');
      type(el, 'Ana');
      await submit(harness, el);
      const alert = el.querySelector('app-auth-notice[role="alert"]');
      expect(alert?.textContent).toContain('Sem conexão com o servidor.');
      expect(alert?.textContent).toContain('O nome não foi salvo.');
      expect(router().url).toBe('/boas-vindas?next=%2Ftv');
      expect(field(el).value).toBe('Ana');
      expect(submitButton(el).disabled).toBe(false);

      // A rede volta: o mesmo botão salva e leva ao destino. Nada ficou preso.
      await submit(harness, el);
      expect(router().url).toBe('/tv');
      expect(api.updateMe).toHaveBeenCalledTimes(2);
    });

    it('a rate limit asks to wait for the time the API gave', async () => {
      api.updateMe.mockRejectedValue(problem(429, {}, 45));
      const { harness, el } = await open();
      await submit(harness, el);
      const alert = el.querySelector('app-auth-notice[role="alert"]');
      expect(alert?.textContent).toContain('Muitas tentativas seguidas.');
      expect(alert?.textContent).toContain('45 segundos');
      expect(router().url).toBe('/boas-vindas');
    });

    it('an account without access says so and does not navigate', async () => {
      api.updateMe.mockRejectedValue(problem(403));
      const { harness, el } = await open();
      await submit(harness, el);
      expect(el.querySelector('app-auth-notice[role="alert"]')?.textContent).toContain(
        'não tem mais acesso',
      );
      expect(router().url).toBe('/boas-vindas');
    });

    it('a failure on the server is told gently, and the person can try again', async () => {
      api.updateMe.mockRejectedValue(problem(500));
      const { harness, el } = await open();
      await submit(harness, el);
      expect(el.querySelector('app-auth-notice')?.textContent).toContain(
        'Não foi possível salvar agora.',
      );
      expect(submitButton(el).disabled).toBe(false);
    });
  });

  it('ignores a second tap while the first is still saving', async () => {
    let finish!: () => void;
    api.updateMe.mockImplementation(
      (_token: string, name: string) =>
        new Promise((resolve) => (finish = () => resolve(confirmed(name)))),
    );
    const { harness, el } = await open();
    submitButton(el).click();
    harness.detectChanges();
    expect(submitButton(el).disabled).toBe(true);
    expect(el.querySelector('.ui-spinner')).not.toBeNull();
    await vi.waitFor(() => expect(api.updateMe).toHaveBeenCalledTimes(1));
    // Mesmo se o evento de envio chegar de novo (Enter no campo), nada é enviado enquanto o primeiro não termina.
    field(el).form!.dispatchEvent(new Event('submit', { cancelable: true }));
    await harness.fixture.whenStable();
    expect(api.updateMe).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(router().url).toBe('/'));
  });

  describe('whoever does not need it never stays here', () => {
    it('a user who already chose the name goes straight to where they were heading', async () => {
      api.me.mockResolvedValue(confirmed('Ana'));
      await open('/boas-vindas?next=%2Ftv');
      await vi.waitFor(() => expect(router().url).toBe('/tv'));
      expect(api.updateMe).not.toHaveBeenCalled();
    });

    it('a user the server did not describe (no connection) is not kept here either', async () => {
      api.me.mockRejectedValue(networkProblem());
      await open();
      await vi.waitFor(() => expect(router().url).toBe('/'));
    });

    it('an answer without the field (an older server) is not asked', async () => {
      api.me.mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'A', role: 'owner' });
      await open();
      await vi.waitFor(() => expect(router().url).toBe('/'));
    });
  });
});
