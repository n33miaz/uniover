import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { AuthService } from './auth.service';
import { AcceptInvitePage, WELCOME_MS } from './accept-invite.page';
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

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

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
    harness.fixture.detectChanges();
  };
  const blur = (el: HTMLElement, id: string) => {
    field(el, id).dispatchEvent(new Event('blur'));
    harness.fixture.detectChanges();
  };
  const submitForm = async (el: HTMLElement) => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
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
    await submitForm(el);
  }
  const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim();
  const text = (el: HTMLElement, selector: string) =>
    clean(el.querySelector(selector)?.textContent);
  const notice = (el: HTMLElement) => el.querySelector<HTMLElement>('app-auth-notice');
  const state = (el: HTMLElement) => el.querySelector<HTMLElement>('app-auth-state');
  const toggles = (el: HTMLElement) => el.querySelectorAll<HTMLButtonElement>('.toggle');

  it('reads the secret from the fragment, takes it off the address bar and never shows it', async () => {
    const el = await render();
    expect(TestBed.inject(Router).url).toBe('/convite');
    expect(el.textContent).not.toContain(SECRET);
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('opens with a single short title inside the shared frame, and no explanatory text', async () => {
    const el = await render();
    expect(el.querySelector('app-auth-layout main')).not.toBeNull();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(text(el, 'h1')).toBe('Criar conta');
    expect(el.querySelector('.lead')).toBeNull();
  });

  it('has labeled fields, autofill hints that pair with the login, and says there is no recovery', async () => {
    const el = await render();
    expect(el.querySelector('label[for="invite-email"]')?.textContent).toBe('E-mail');
    expect(el.querySelector('label[for="invite-password"]')?.textContent).toBe('Senha');
    expect(el.querySelector('label[for="invite-confirmation"]')?.textContent).toBe(
      'Repita a senha',
    );
    // `username` (e não `email`): é o que faz o gerenciador de senhas ligar a senha nova ao login em /entrar.
    expect(field(el, 'invite-email').autocomplete).toBe('username');
    expect(field(el, 'invite-password').autocomplete).toBe('new-password');
    expect(field(el, 'invite-confirmation').autocomplete).toBe('new-password');
    expect(field(el, 'invite-password').type).toBe('password');
    expect(field(el, 'invite-confirmation').getAttribute('enterkeyhint')).toBe('go');
    expect(text(el, '#invite-password-hint')).toContain('Não existe recuperação de senha');
    // Nenhum campo ganha foco sozinho: a pessoa lê o que está acontecendo antes de digitar.
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });

  it('presses the submit button without taking focus from the field (so a warning cannot move it under the finger)', async () => {
    const el = await render();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.querySelector('.submit')!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('is honest about what is recorded, in one short line', async () => {
    const el = await render();
    expect(text(el, '.audit')).toBe('Este acesso fica registrado: data, IP e aparelho.');
  });

  it('has one plain action, "Continuar"', async () => {
    const el = await render();
    expect(text(el, '.submit')).toBe('Continuar');
  });

  it('shows and hides each password on its own, with its own accessible name', async () => {
    const el = await render();
    const [first, second] = Array.from(toggles(el));
    expect(first.getAttribute('aria-label')).toBe('Mostrar senha');
    expect(second.getAttribute('aria-label')).toBe('Mostrar a senha repetida');
    first.click();
    harness.fixture.detectChanges();
    expect(field(el, 'invite-password').type).toBe('text');
    expect(field(el, 'invite-confirmation').type).toBe('password');
    expect(first.getAttribute('aria-pressed')).toBe('true');
    second.click();
    harness.fixture.detectChanges();
    expect(field(el, 'invite-confirmation').type).toBe('text');
  });

  describe('live password requirements', () => {
    it('starts pending, with a different icon and spoken text (not only colour), then turns met', async () => {
      const el = await render();
      const rule = el.querySelector<HTMLElement>('.rule')!;
      expect(rule.dataset['state']).toBe('pending');
      expect(text(el, '.rule')).toMatch(/^Ao menos 10 caracteress*: pendente$/);
      expect(el.querySelector('.rules')?.getAttribute('aria-label')).toBe('Requisitos da senha');
      const pendingIcon = rule.querySelector('svg')!.innerHTML;

      type(el, 'invite-password', 'curta1');
      expect(rule.dataset['state']).toBe('pending');
      type(el, 'invite-password', 'dez-letras');
      expect(rule.dataset['state']).toBe('met');
      expect(text(el, '.rule')).toMatch(/^Ao menos 10 caracteress*: cumprido$/);
      expect(rule.querySelector('svg')!.innerHTML).not.toBe(pendingIcon);
      expect(rule.querySelector('.ui-visually-hidden')).not.toBeNull();
    });

    it('links the field to the requirements and to the no-recovery hint', async () => {
      const el = await render();
      expect(field(el, 'invite-password').getAttribute('aria-describedby')).toBe(
        'invite-password-rules invite-password-hint',
      );
      expect(el.querySelector('#invite-password-rules')).not.toBeNull();
    });

    it.each([
      ['', 0, 'Força da senha'],
      ['curta1', 1, 'Força: Fraca'],
      ['abcdefghij', 2, 'Força: Razoável'],
      ['abcdefghijklmn', 3, 'Força: Boa'],
      ['Uma-senha-bem-longa-9!', 4, 'Força: Forte'],
    ])('rates %j at level %i and says it in words (%s)', async (password, level, label) => {
      const el = await render();
      type(el, 'invite-password', password);
      expect(el.querySelector<HTMLElement>('.strength')?.dataset['level']).toBe(String(level));
      expect(text(el, '.strength-text')).toBe(label);
      // Os trechos coloridos são só desenho: o nome da força é o que se lê.
      expect(el.querySelector('.segments')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('never blocks on strength: a weak but long enough password goes to the server', async () => {
      api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      const el = await render();
      await fillAndSubmit(el, 'ana@exemplo.com', 'aaaaaaaaaaaa');
      expect(api.acceptInvite).toHaveBeenCalledWith(SECRET, 'ana@exemplo.com', 'aaaaaaaaaaaa');
    });

    it('announces only what changed, once typing stops (no running commentary)', async () => {
      const el = await render();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const region = () => text(el, 'p.ui-visually-hidden[role="status"]');
      expect(region()).toBe('');

      type(el, 'invite-password', 'a');
      type(el, 'invite-password', 'ab');
      type(el, 'invite-password', 'abc');
      vi.advanceTimersByTime(500);
      harness.fixture.detectChanges();
      expect(region()).toBe(''); // ainda digitando, e continua pendente: nada a dizer

      type(el, 'invite-password', 'abcdefghijkl');
      vi.advanceTimersByTime(100);
      harness.fixture.detectChanges();
      expect(region()).toBe(''); // a digitação acabou de mexer: espera parar
      vi.advanceTimersByTime(1_000);
      harness.fixture.detectChanges();
      expect(region()).toBe(
        'Requisito cumprido: ao menos 10 caracteres. Força da senha: Razoável.',
      );

      type(el, 'invite-confirmation', 'abcdefghijkl');
      vi.advanceTimersByTime(1_000);
      harness.fixture.detectChanges();
      expect(region()).toBe('As senhas conferem.');

      type(el, 'invite-password', 'abc');
      vi.advanceTimersByTime(1_000);
      harness.fixture.detectChanges();
      expect(region()).toBe('Requisito pendente: ao menos 10 caracteres. As senhas não conferem.');
    });
  });

  describe('confirmation', () => {
    it('says the passwords match as soon as they do, in words and with an icon', async () => {
      const el = await render();
      type(el, 'invite-password', 'uma-senha-longa');
      type(el, 'invite-confirmation', 'uma-senha-longa');
      expect(text(el, '#invite-confirmation-status')).toBe('As senhas conferem.');
      expect(el.querySelector<HTMLElement>('#invite-confirmation-status')?.dataset['tone']).toBe(
        'ok',
      );
      expect(field(el, 'invite-confirmation').getAttribute('aria-describedby')).toBe(
        'invite-confirmation-status',
      );
      expect(field(el, 'invite-confirmation').hasAttribute('aria-invalid')).toBe(false);
    });

    it('only complains about a mismatch after the field loses focus, and never as an alert', async () => {
      const el = await render();
      type(el, 'invite-password', 'uma-senha-longa');
      type(el, 'invite-confirmation', 'uma-senha');
      expect(el.querySelector('#invite-confirmation-status')).toBeNull();

      blur(el, 'invite-confirmation');
      expect(text(el, '#invite-confirmation-status')).toBe('As senhas ainda não são iguais.');
      // Só ao sair do campo o tom é de aviso (âmbar); o de erro vem com um envio recusado.
      expect(el.querySelector<HTMLElement>('#invite-confirmation-status')?.dataset['tone']).toBe(
        'warn',
      );
      expect(field(el, 'invite-confirmation').getAttribute('aria-invalid')).toBe('true');
      expect(notice(el)).toBeNull();

      type(el, 'invite-confirmation', 'uma-senha-longa');
      expect(text(el, '#invite-confirmation-status')).toBe('As senhas conferem.');
    });
  });

  describe('e-mail', () => {
    it('is checked gently: after blur, never while typing, and fixed as soon as it is right', async () => {
      const el = await render();
      type(el, 'invite-email', 'ana');
      expect(el.querySelector('#invite-email-error')).toBeNull();
      blur(el, 'invite-email');
      expect(text(el, '#invite-email-error')).toContain('Confira o e-mail');
      expect(field(el, 'invite-email').getAttribute('aria-describedby')).toBe('invite-email-error');
      type(el, 'invite-email', 'ana@exemplo.com');
      expect(el.querySelector('#invite-email-error')).toBeNull();
    });
  });

  describe('submitting', () => {
    it('sends the secret, the e-mail and the password, and a guest lands straight on the TV', async () => {
      api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      const el = await render();
      await fillAndSubmit(el, '  ana@exemplo.com ');
      expect(api.acceptInvite).toHaveBeenCalledWith(SECRET, 'ana@exemplo.com', 'uma-senha-longa');
      expect(TestBed.inject(SessionState).status()).toBe('authenticated');
      expect(TestBed.inject(SessionState).isGuest()).toBe(true);
      // Sem clicar em nada, o "tudo pronto" segue sozinho.
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'), {
        timeout: WELCOME_MS + 2_000,
      });
    });

    it('shows a short "all set" step first, and Continue goes right away (only once)', async () => {
      api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      const el = await render();
      await fillAndSubmit(el);
      expect(el.querySelector('form')).toBeNull();
      expect(text(el, 'h1')).toBe('Tudo pronto');
      expect(el.querySelectorAll('h1')).toHaveLength(1);
      expect(state(el)?.dataset['tone']).toBe('ok');
      expect(el.querySelector('[role="status"]')).not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(el.querySelector('.copy')));
      expect(TestBed.inject(Router).url).toBe('/convite');

      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      const next = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Continuar',
      )!;
      next.click();
      next.click();
      expect(navigate).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/tv'));
    });

    it('keeps the secret and the passwords out of every storage', async () => {
      api.acceptInvite.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      const el = await render();
      await fillAndSubmit(el);
      await vi.waitFor(() => expect(api.acceptInvite).toHaveBeenCalled());
      const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain('uma-senha-longa');
    });

    it('keeps the button busy with a spinner and ignores a second send', async () => {
      let finish!: (value: unknown) => void;
      api.acceptInvite.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const el = await render();
      type(el, 'invite-email', 'ana@exemplo.com');
      type(el, 'invite-password', 'uma-senha-longa');
      type(el, 'invite-confirmation', 'uma-senha-longa');
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      harness.fixture.detectChanges();
      const submit = el.querySelector<HTMLButtonElement>('.submit')!;
      expect(submit.disabled).toBe(true);
      expect(submit.textContent?.trim()).toBe('Criando…');
      expect(submit.querySelector('.ui-spinner')).not.toBeNull();
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(api.acceptInvite).toHaveBeenCalledTimes(1);
      finish({ accessToken: 't', expiresIn: 600 });
      await harness.fixture.whenStable();
    });

    it('refuses a short password without calling the server, in an alert, and focuses the password', async () => {
      const el = await render();
      await fillAndSubmit(el, 'ana@exemplo.com', 'curta-1');
      expect(text(el, 'app-auth-notice')).toBe('A senha precisa ter ao menos 10 caracteres.');
      expect(notice(el)?.getAttribute('role')).toBe('alert');
      expect(api.acceptInvite).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field(el, 'invite-password'));
      expect(field(el, 'invite-password').getAttribute('aria-invalid')).toBe('true');
      expect(el.querySelector<HTMLElement>('.rule')?.dataset['state']).toBe('invalid');
    });

    it('refuses two different passwords without calling the server, with one message only, at the confirmation field', async () => {
      const el = await render();
      await fillAndSubmit(el, 'ana@exemplo.com', 'uma-senha-longa', 'outra-senha-longa');
      expect(api.acceptInvite).not.toHaveBeenCalled();
      // Antes havia a mesma frase duas vezes (embaixo do campo e numa faixa no alto): a faixa é só para erro da API.
      expect(notice(el)).toBeNull();
      expect(el.querySelector('[role="alert"]')).toBeNull();
      const status = el.querySelector<HTMLElement>('#invite-confirmation-status')!;
      expect(clean(status.textContent)).toBe('As senhas ainda não são iguais.');
      expect(status.dataset['tone']).toBe('bad');
      expect(status.querySelector('svg')).not.toBeNull();
      // O texto é do campo: o leitor de tela o ouve junto com o rótulo.
      const confirmation = field(el, 'invite-confirmation');
      expect(confirmation.getAttribute('aria-invalid')).toBe('true');
      expect(confirmation.getAttribute('aria-describedby')).toBe('invite-confirmation-status');
      await vi.waitFor(() => expect(document.activeElement).toBe(confirmation));
    });

    it('says why aloud when the send leaves the confirmation field itself, where the focus would not move', async () => {
      const el = await render();
      type(el, 'invite-email', 'ana@exemplo.com');
      type(el, 'invite-password', 'uma-senha-longa');
      type(el, 'invite-confirmation', 'outra-senha-longa');
      field(el, 'invite-confirmation').focus();
      await submitForm(el);
      const region = () => text(el, 'p.ui-visually-hidden[role="status"]');
      await vi.waitFor(() => {
        harness.fixture.detectChanges();
        expect(region()).toBe('As senhas ainda não são iguais.');
      });
      expect(notice(el)).toBeNull();
    });

    it('asks for the repeated password in the same single message when it was left empty', async () => {
      const el = await render();
      type(el, 'invite-email', 'ana@exemplo.com');
      type(el, 'invite-password', 'uma-senha-longa');
      await submitForm(el);
      expect(api.acceptInvite).not.toHaveBeenCalled();
      expect(notice(el)).toBeNull();
      expect(text(el, '#invite-confirmation-status')).toBe('Repita a senha para conferir.');
      expect(field(el, 'invite-confirmation').getAttribute('aria-invalid')).toBe('true');
    });

    it('refuses an e-mail with no shape at the e-mail field, without an alert', async () => {
      const el = await render();
      await fillAndSubmit(el, 'ana');
      expect(api.acceptInvite).not.toHaveBeenCalled();
      expect(text(el, '#invite-email-error')).toContain('Confira o e-mail');
      expect(document.activeElement).toBe(field(el, 'invite-email'));
      expect(notice(el)).toBeNull();
    });
  });

  describe('server refusals', () => {
    it.each([
      [new ApiProblem(400, '', 'x'), 'Confira o e-mail e a senha digitados.'],
      [networkProblem(), 'Sem conexão com o servidor.'],
      [new ApiProblem(500, '', 'x'), 'Não foi possível criar a conta agora.'],
    ])(
      'explains refusal %# in plain words, stays on the page and keeps what was typed',
      async (problem, message) => {
        api.acceptInvite.mockRejectedValue(problem);
        const el = await render();
        await fillAndSubmit(el);
        expect(text(el, 'app-auth-notice')).toContain(message);
        expect(notice(el)?.getAttribute('role')).toBe('alert');
        expect(TestBed.inject(Router).url).toBe('/convite');
        expect(field(el, 'invite-password').value).toBe('uma-senha-longa');
        await vi.waitFor(() => expect(document.activeElement).toBe(notice(el)));
      },
    );

    it('takes an already used e-mail (409) to the e-mail field, selected, and clears the message when edited', async () => {
      api.acceptInvite.mockRejectedValue(new ApiProblem(409, 'email-unavailable', 'x'));
      const el = await render();
      const select = vi.spyOn(HTMLInputElement.prototype, 'select');
      await fillAndSubmit(el);
      expect(el.querySelector('form')).not.toBeNull();
      // O campo repete o essencial; a faixa explica o que fazer (e o convite segue valendo).
      expect(text(el, '#invite-email-error')).toBe('Escolha outro e-mail.');
      expect(field(el, 'invite-email').getAttribute('aria-invalid')).toBe('true');
      await vi.waitFor(() => expect(document.activeElement).toBe(field(el, 'invite-email')));
      expect(select).toHaveBeenCalled();
      expect(notice(el)?.getAttribute('role')).toBe('alert');
      expect(notice(el)?.dataset['tone']).toBe('warn');
      expect(text(el, 'app-auth-notice .heading')).toBe('Este e-mail não pode ser usado.');
      expect(text(el, 'app-auth-notice .detail')).toContain('O seu convite continua valendo');

      // O mesmo e-mail não é reenviado; outro e-mail limpa o aviso.
      await submitForm(el);
      expect(api.acceptInvite).toHaveBeenCalledTimes(1);
      type(el, 'invite-email', 'outra@exemplo.com');
      expect(el.querySelector('#invite-email-error')).toBeNull();
      expect(notice(el)).toBeNull();
    });

    it('replaces the form with a dedicated state for an invite that no longer works (410)', async () => {
      api.acceptInvite.mockRejectedValue(new ApiProblem(410, 'invite-invalid', 'x'));
      const el = await render();
      await fillAndSubmit(el);
      expect(el.querySelector('form')).toBeNull();
      expect(el.querySelectorAll('h1')).toHaveLength(1);
      expect(text(el, 'h1')).toBe('Este convite não vale mais');
      // Só o título e o que fazer: a API não diz qual foi a causa (usado, vencido ou cancelado), então a tela não a afirma.
      expect(el.querySelector('app-auth-state .detail')).toBeNull();
      expect(text(el, 'app-auth-state .advice')).toContain('Peça um novo link');
      // O que fazer está dentro do bloco anunciado, para o leitor de tela ouvir os dois.
      expect(el.querySelector('[role="alert"] .advice')).not.toBeNull();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Este convite não vale mais',
      );
      expect(el.querySelector('a[href="/entrar"]')?.textContent).toContain('Já tenho conta');
      expect(TestBed.inject(Router).url).toBe('/convite');
      await vi.waitFor(() => expect(document.activeElement).toBe(el.querySelector('.copy')));
    });

    describe('rate limit (429)', () => {
      const fakeClock = () =>
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

      it('counts the wait down, blocks new sends and says the wait once in words', async () => {
        fakeClock();
        api.acceptInvite.mockRejectedValue(new ApiProblem(429, '', 'x', null, null, 30));
        const el = await render();
        await fillAndSubmit(el);
        expect(text(el, 'app-auth-notice')).toContain('Muitas tentativas seguidas');
        expect(text(el, '.wait-time')).toBe('0:30');
        expect(text(el, 'app-auth-notice .ui-visually-hidden')).toContain(
          'Tente de novo em 30 segundos.',
        );
        expect(el.querySelector<HTMLButtonElement>('.submit')!.disabled).toBe(true);
        const calls = api.acceptInvite.mock.calls.length;
        el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
        expect(api.acceptInvite.mock.calls.length).toBe(calls);

        await vi.advanceTimersByTimeAsync(10_000);
        harness.fixture.detectChanges();
        expect(text(el, '.wait-time')).toBe('0:20');
      });

      it('becomes a calm "ready" status by itself when the wait is over', async () => {
        fakeClock();
        api.acceptInvite.mockRejectedValue(new ApiProblem(429, '', 'x', null, null, 2));
        const el = await render();
        await fillAndSubmit(el);
        await vi.advanceTimersByTimeAsync(2_000);
        harness.fixture.detectChanges();
        expect(notice(el)?.getAttribute('role')).toBe('status');
        expect(text(el, 'app-auth-notice')).toBe('Pronto, você já pode tentar de novo.');
        expect(el.querySelector<HTMLButtonElement>('.submit')!.disabled).toBe(false);
      });

      it('explains the limit without a countdown when the server gives no time', async () => {
        api.acceptInvite.mockRejectedValue(new ApiProblem(429, '', 'x'));
        const el = await render();
        await fillAndSubmit(el);
        expect(text(el, 'app-auth-notice')).toContain('Muitas tentativas seguidas');
        expect(el.querySelector('.wait')).toBeNull();
        expect(el.querySelector<HTMLButtonElement>('.submit')!.disabled).toBe(false);
      });
    });
  });

  describe('address without a usable invite', () => {
    it('explains that the address carries no invite, in an alert with a way out', async () => {
      const el = await render('/convite');
      expect(el.querySelector('form')).toBeNull();
      expect(el.querySelectorAll('h1')).toHaveLength(1);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Abra o link do convite');
      expect(el.querySelector('app-auth-state .advice')).toBeNull();
      expect(el.querySelector('a[href="/entrar"]')).not.toBeNull();
    });

    it('does not accept a fragment that does not look like a secret, and never echoes it', async () => {
      const el = await render('/convite#<script>alert(1)</script>');
      expect(el.querySelector('form')).toBeNull();
      expect(text(el, 'h1')).toBe('Convite incompleto');
      expect(el.textContent).not.toContain('script');
      expect(api.acceptInvite).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe('/convite');
    });

    it('follows a link pasted into the same tab (only the fragment changes) and still hides it', async () => {
      const el = await render('/convite');
      expect(el.querySelector('form')).toBeNull();
      await harness.navigateByUrl(`/convite#${SECRET}`);
      await harness.fixture.whenStable();
      harness.fixture.detectChanges();
      expect(el.querySelector('form')).not.toBeNull();
      expect(TestBed.inject(Router).url).toBe('/convite');
      expect(el.textContent).not.toContain(SECRET);
    });
  });
});
