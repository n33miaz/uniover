import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { AuthService } from './auth.service';
import { AcceptInvitePage } from './accept-invite.page';
import { ownerOnlyGuard } from './role.guard';

@Component({ template: '' })
class Blank {}

/** Segredo de teste no formato real (base64url de 32 bytes). */
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCde';

describe('AcceptInvitePage', () => {
  const api = { acceptInvite: vi.fn(), me: vi.fn(), refresh: vi.fn() };
  let harness: RouterTestingHarness;

  beforeEach(() => {
    localStorage.clear();
    api.acceptInvite.mockReset();
    api.refresh.mockReset().mockRejectedValue(new ApiProblem(401, '', 'x'));
    api.me
      .mockReset()
      .mockResolvedValue({ id: '1', email: 'ana@exemplo.com', displayName: 'Ana', role: 'guest' });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'convite', component: AcceptInvitePage },
          { path: 'entrar', component: Blank },
          { path: 'tv', component: Blank },
          { path: '', component: Blank, canMatch: [ownerOnlyGuard] },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  async function render(url = `/convite#${SECRET}`) {
    // O app confirma a sessão na partida (inicializador); aqui ela acaba anônima, como para quem abre o link sem entrar.
    await TestBed.inject(AuthService).init();
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  }

  const field = (el: HTMLElement, id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
  const type = (el: HTMLElement, id: string, value: string) => {
    const input = field(el, id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  async function fillAndSubmit(
    el: HTMLElement,
    email = 'ana@exemplo.com',
    password = 'uma-senha-longa',
    confirmation = password,
  ) {
    type(el, 'invite-email', email);
    type(el, 'invite-password', password);
    type(el, 'invite-confirmation', confirmation);
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
  }
  const errorText = (el: HTMLElement) =>
    el.querySelector('.error')?.textContent?.replace(/\s+/g, ' ').trim();

  it('reads the secret from the fragment, takes it off the address bar and never shows it', async () => {
    const el = await render();
    expect(TestBed.inject(Router).url).toBe('/convite');
    expect(el.textContent).not.toContain(SECRET);
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('has labeled fields, new-password hints, a warning that there is no recovery, and focuses the e-mail', async () => {
    const el = await render();
    expect(el.querySelector('label[for="invite-email"]')?.textContent).toBe('E-mail');
    expect(el.querySelector('label[for="invite-password"]')?.textContent).toBe('Senha');
    expect(el.querySelector('label[for="invite-confirmation"]')?.textContent).toBe(
      'Repita a senha',
    );
    expect(field(el, 'invite-email').autocomplete).toBe('username');
    expect(field(el, 'invite-password').autocomplete).toBe('new-password');
    expect(field(el, 'invite-password').type).toBe('password');
    expect(el.querySelector('#invite-password-hint')?.textContent).toContain(
      'Não existe recuperação de senha',
    );
    expect(el.querySelector('#invite-password-hint')?.textContent).toContain('10 caracteres');
    expect(document.activeElement).toBe(field(el, 'invite-email'));
  });

  it('shows and hides both passwords together', async () => {
    const el = await render();
    el.querySelector<HTMLButtonElement>('.toggle')!.click();
    harness.fixture.detectChanges();
    expect(field(el, 'invite-password').type).toBe('text');
    expect(field(el, 'invite-confirmation').type).toBe('text');
  });

  it('sends the secret, the e-mail and the password, and a guest lands straight on the TV', async () => {
    api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render();
    await fillAndSubmit(el, '  ana@exemplo.com ');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'));
    expect(api.acceptInvite).toHaveBeenCalledWith(SECRET, 'ana@exemplo.com', 'uma-senha-longa');
    expect(TestBed.inject(SessionState).status()).toBe('authenticated');
    expect(TestBed.inject(SessionState).isGuest()).toBe(true);
  });

  it('keeps the secret out of every storage', async () => {
    api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const el = await render();
    await fillAndSubmit(el);
    await vi.waitFor(() => expect(api.acceptInvite).toHaveBeenCalled());
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('uma-senha-longa');
  });

  it('refuses a short password without calling the server', async () => {
    const el = await render();
    await fillAndSubmit(el, 'ana@exemplo.com', 'curta-1');
    expect(errorText(el)).toBe('A senha precisa ter ao menos 10 caracteres.');
    expect(el.querySelector('.error')?.getAttribute('role')).toBe('alert');
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });

  it('refuses two different passwords without calling the server', async () => {
    const el = await render();
    await fillAndSubmit(el, 'ana@exemplo.com', 'uma-senha-longa', 'outra-senha-longa');
    expect(errorText(el)).toBe('As duas senhas não são iguais.');
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ApiProblem(410, 'invite-invalid', 'x'),
      'Este convite não vale mais. Peça um novo a quem o enviou.',
    ],
    [
      new ApiProblem(409, 'email-unavailable', 'x'),
      'Este e-mail não pode ser usado. Escolha outro.',
    ],
    [new ApiProblem(400, '', 'x'), 'Confira o e-mail e a senha digitados.'],
    [networkProblem(), 'Sem conexão com o servidor. Tente de novo.'],
    [new ApiProblem(500, '', 'x'), 'Não foi possível criar a conta agora. Tente de novo.'],
  ])('explains a refusal (%#) in plain words and stays on the page', async (problem, message) => {
    api.acceptInvite.mockRejectedValue(problem);
    const el = await render();
    await fillAndSubmit(el);
    expect(errorText(el)).toBe(message);
    expect(TestBed.inject(Router).url).toBe('/convite');
    expect(field(el, 'invite-password').value).toBe('uma-senha-longa');
  });

  it('tells how long to wait when rate limited', async () => {
    api.acceptInvite.mockRejectedValue(new ApiProblem(429, '', 'x', null, null, 30));
    const el = await render();
    await fillAndSubmit(el);
    expect(errorText(el)).toContain('Muitas tentativas seguidas');
    expect(errorText(el)).toContain('30 s');
  });

  it('asks for the invite link when the address carries no secret', async () => {
    const el = await render('/convite');
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Abra o link do convite');
    expect(el.querySelector('a[href="/entrar"]')).not.toBeNull();
  });

  it('does not accept a fragment that does not look like a secret', async () => {
    const el = await render('/convite#<script>alert(1)</script>');
    expect(el.querySelector('form')).toBeNull();
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });
});
