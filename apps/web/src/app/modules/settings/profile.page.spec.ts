import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { ProfilePage } from './profile.page';

const OWNER = {
  id: '1',
  email: 'dono@exemplo.com',
  displayName: 'Dono da Casa',
  role: 'owner',
  displayNameConfirmed: true,
  permissions: [
    'module:tv',
    'tv:control',
    'tv:power',
    'tv:launch',
    'tv:edit-shortcuts',
    'tv:history',
    'module:training',
  ],
};
const GUEST = {
  id: '2',
  email: 'alice@exemplo.com',
  displayName: 'Alice',
  role: 'guest',
  displayNameConfirmed: true,
  permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history'],
};

describe('ProfilePage', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    updateMe: vi.fn(),
    logout: vi.fn(),
    passkeys: vi.fn(),
    guests: vi.fn(),
    guestInvites: vi.fn(),
  };
  const problem = (status: number, fieldErrors = {}, retryAfter: number | null = null) =>
    new ApiProblem(status, '', 'x', null, null, retryAfter, fieldErrors);

  beforeEach(() => {
    localStorage.clear();
    for (const fn of Object.values(api)) fn.mockReset();
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockResolvedValue(OWNER);
    api.logout.mockResolvedValue(undefined);
    api.updateMe.mockImplementation(async (_token: string, name: string) => ({
      ...OWNER,
      displayName: name,
    }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'entrar', children: [] }]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(ProfilePage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el };
  }
  const input = (el: HTMLElement) => el.querySelector<HTMLInputElement>('#profile-name')!;
  const saveButton = (el: HTMLElement) =>
    el.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
  const type = (el: HTMLElement, value: string) => {
    input(el).value = value;
    input(el).dispatchEvent(new Event('input'));
  };
  const save = async (
    fixture: { whenStable(): Promise<unknown>; detectChanges(): void },
    el: HTMLElement,
  ) => {
    saveButton(el).click();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  describe('identity', () => {
    it('shows the name, the e-mail (read only) and the initial of the name in the avatar', async () => {
      const { el } = await render();
      expect(el.querySelector('.facts')?.textContent).toContain('Dono da Casa');
      expect(el.querySelector('.facts')?.textContent).toContain('dono@exemplo.com');
      expect(el.querySelector('.avatar')?.textContent?.trim()).toBe('D');
      expect(el.querySelector('.avatar')?.getAttribute('aria-hidden')).toBe('true');
      // O e-mail não é um campo: não há como editá-lo daqui.
      expect(el.querySelectorAll('input[type="email"], input[name="email"]')).toHaveLength(0);
    });

    it('calls the owner "Administrador"', async () => {
      const { el } = await render();
      expect(el.querySelector('.role-text')?.textContent?.trim()).toBe('Administrador');
      expect(el.querySelector('.all')?.textContent).toContain('tem acesso a tudo');
    });

    it('calls the guest "Convidado" and lists what the guest can do, from the permissions', async () => {
      api.me.mockResolvedValue(GUEST);
      const { el } = await render();
      expect(el.querySelector('.role-text')?.textContent?.trim()).toBe('Convidado');
      expect(
        Array.from(el.querySelectorAll('.abilities-list li')).map((li) => li.textContent?.trim()),
      ).toEqual(['Controlar a TV', 'Desligar a TV', 'Abrir apps', 'Ver o histórico']);
      // Não tem editar atalhos nem Treino: a lista não promete o que a API não liberou.
      expect(el.querySelector('.abilities')?.textContent).not.toContain('Editar atalhos');
      expect(el.querySelector('.abilities')?.textContent).not.toContain('Treino');
      expect(el.querySelector('.all')).toBeNull();
    });

    it('lists the Training and shortcut permissions when the guest has them', async () => {
      api.me.mockResolvedValue({
        ...GUEST,
        permissions: ['module:tv', 'tv:edit-shortcuts', 'module:training'],
      });
      const { el } = await render();
      expect(
        Array.from(el.querySelectorAll('.abilities-list li')).map((li) => li.textContent?.trim()),
      ).toEqual(['Editar atalhos', 'Usar o Treino']);
    });

    it('says plainly when the guest has nothing released yet', async () => {
      api.me.mockResolvedValue({ ...GUEST, permissions: [] });
      const { el } = await render();
      expect(el.querySelector('.abilities-list')).toBeNull();
      expect(el.querySelector('.abilities')?.textContent).toContain('Nenhuma permissão liberada');
    });
  });

  describe('changing the name', () => {
    it('starts with the current name, a counter and a note that it can be changed any time', async () => {
      const { el } = await render();
      expect(input(el).value).toBe('Dono da Casa');
      expect(el.querySelector('.counter')?.textContent?.trim()).toBe('12 de 60');
      expect(el.querySelector('#profile-name-hint')?.textContent).toContain('quando quiser');
      expect(input(el).getAttribute('autocomplete')).toBe('nickname');
      expect(input(el).getAttribute('aria-describedby')).toBe('profile-name-hint');
    });

    it('only offers "Salvar" once the name is different', async () => {
      const { fixture, el } = await render();
      expect(saveButton(el).disabled).toBe(true);
      type(el, 'Neemias');
      fixture.detectChanges();
      expect(saveButton(el).disabled).toBe(false);
      // Mudar só espaços não é mudar o nome.
      type(el, '  Dono da   Casa ');
      fixture.detectChanges();
      expect(saveButton(el).disabled).toBe(true);
    });

    it('saves in place: no navigation, the new name shows everywhere and "Nome salvo." is announced', async () => {
      const { fixture, el } = await render();
      const router = TestBed.inject(Router);
      const url = router.url;
      type(el, '  Neemias  ');
      fixture.detectChanges();
      await save(fixture, el);
      expect(api.updateMe).toHaveBeenCalledWith('t', 'Neemias');
      expect(router.url).toBe(url);
      expect(TestBed.inject(SessionState).user()?.displayName).toBe('Neemias');
      expect(el.querySelector('.person')?.textContent).toContain('Neemias');
      expect(el.querySelector('.avatar')?.textContent?.trim()).toBe('N');
      expect(input(el).value).toBe('Neemias');
      expect(el.querySelector('.result[role="status"] .saved')?.textContent).toContain(
        'Nome salvo.',
      );
      // Salvo, o botão volta a esperar uma mudança.
      expect(saveButton(el).disabled).toBe(true);
    });

    it('takes the "saved" message away as soon as the person edits again', async () => {
      const { fixture, el } = await render();
      type(el, 'Neemias');
      fixture.detectChanges();
      await save(fixture, el);
      expect(el.querySelector('.saved')).not.toBeNull();
      type(el, 'Neemias J');
      fixture.detectChanges();
      expect(el.querySelector('.saved')).toBeNull();
    });

    it('shows the saving state and ignores a second tap meanwhile', async () => {
      let finish!: () => void;
      api.updateMe.mockImplementation(
        (_token: string, name: string) =>
          new Promise((resolve) => (finish = () => resolve({ ...OWNER, displayName: name }))),
      );
      const { fixture, el } = await render();
      type(el, 'Neemias');
      fixture.detectChanges();
      saveButton(el).click();
      fixture.detectChanges();
      expect(saveButton(el).disabled).toBe(true);
      expect(el.querySelector('form .ui-spinner')).not.toBeNull();
      expect(saveButton(el).textContent).toContain('Salvando');
      await vi.waitFor(() => expect(api.updateMe).toHaveBeenCalledTimes(1));
      // Mesmo se o evento de envio chegar de novo (Enter no campo), nada é enviado enquanto o primeiro não termina.
      input(el).form!.dispatchEvent(new Event('submit', { cancelable: true }));
      await fixture.whenStable();
      expect(api.updateMe).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('.saved')).not.toBeNull();
      });
    });

    it('refuses an empty name before going to the server, with the message on the field', async () => {
      const { fixture, el } = await render();
      type(el, '   ');
      fixture.detectChanges();
      await save(fixture, el);
      expect(api.updateMe).not.toHaveBeenCalled();
      expect(el.querySelector('.error')?.textContent).toContain('Escreva como devemos te chamar.');
      expect(input(el).getAttribute('aria-invalid')).toBe('true');
      expect(input(el).getAttribute('aria-describedby')).toBe(
        'profile-name-error profile-name-hint',
      );
    });

    it('flags a name past 60 characters right away and does not send it', async () => {
      const { fixture, el } = await render();
      type(el, 'a'.repeat(61));
      fixture.detectChanges();
      expect(el.querySelector('.counter')?.classList.contains('over')).toBe(true);
      expect(el.querySelector('.error')?.textContent).toContain('até 60 caracteres');
      await save(fixture, el);
      expect(api.updateMe).not.toHaveBeenCalled();
    });

    it('shows the message the API gave for the name, on the field, and keeps what was typed', async () => {
      api.updateMe.mockRejectedValue(
        problem(400, { displayName: ['Use só letras, números, espaços e emojis comuns.'] }),
      );
      const { fixture, el } = await render();
      type(el, 'Neemias​');
      fixture.detectChanges();
      await save(fixture, el);
      expect(el.querySelector('.error')?.textContent).toContain('Use só letras, números');
      expect(input(el).getAttribute('aria-invalid')).toBe('true');
      expect(input(el).value).toBe('Neemias​');
      expect(TestBed.inject(SessionState).user()?.displayName).toBe('Dono da Casa');
      expect(el.querySelector('.saved')).toBeNull();
    });

    it.each([
      ['no connection', networkProblem(), 'Sem conexão com o servidor.'],
      ['a rate limit', problem(429, {}, 20), 'Muitas tentativas seguidas.'],
      ['an account without access', problem(403), 'não tem mais acesso'],
      ['a server failure', problem(500), 'Não foi possível salvar agora.'],
    ])('tells about %s in a notice, without losing the name typed', async (_label, error, text) => {
      api.updateMe.mockRejectedValue(error);
      const { fixture, el } = await render();
      type(el, 'Neemias');
      fixture.detectChanges();
      await save(fixture, el);
      expect(el.querySelector('.ui-notice.warn[role="alert"]')?.textContent).toContain(text);
      expect(input(el).value).toBe('Neemias');
      expect(saveButton(el).disabled).toBe(false);
    });

    it('works the same for a guest', async () => {
      api.me.mockResolvedValue(GUEST);
      api.updateMe.mockImplementation(async (_token: string, name: string) => ({
        ...GUEST,
        displayName: name,
      }));
      const { fixture, el } = await render();
      type(el, 'Ali');
      fixture.detectChanges();
      await save(fixture, el);
      expect(api.updateMe).toHaveBeenCalledWith('t', 'Ali');
      expect(el.querySelector('.saved')).not.toBeNull();
    });
  });

  describe('session', () => {
    it('says the session is active and signs out', async () => {
      const { fixture, el } = await render();
      expect(el.querySelector('.session')?.textContent).toContain('Sessão ativa.');
      expect(el.querySelector('.session')?.classList.contains('ok')).toBe(true);

      el.querySelector<HTMLButtonElement>('button.secondary')!.click();
      await fixture.whenStable();
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/entrar'));
      expect(api.logout).toHaveBeenCalledWith('t');
    });

    it('says the session is pending, without alarm, when the server cannot confirm it', async () => {
      api.refresh.mockRejectedValue(networkProblem());
      const { el } = await render();
      expect(el.querySelector('.session')?.textContent).toContain('Sessão a confirmar');
      expect(el.querySelector('.session')?.textContent).toContain('Nada foi apagado');
      expect(el.querySelector('.session')?.classList.contains('warn')).toBe(true);
      expect(el.querySelector('.session')?.classList.contains('bad')).toBe(false);
    });

    it('warns when sign-out could not reach the server', async () => {
      api.logout.mockRejectedValue(networkProblem());
      const { fixture, el } = await render();
      el.querySelector<HTMLButtonElement>('button.secondary')!.click();
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/entrar'));
      fixture.detectChanges();
      expect(el.textContent).toContain('o servidor ainda não soube');
    });
  });

  it.each([
    ['administrator', OWNER],
    ['guest', GUEST],
  ])('only uses the own account (no administrator route) as %s', async (_role, me) => {
    api.me.mockResolvedValue(me);
    const { fixture, el } = await render();
    type(el, 'Outro nome');
    fixture.detectChanges();
    await save(fixture, el);
    expect(api.passkeys).not.toHaveBeenCalled();
    expect(api.guests).not.toHaveBeenCalled();
    expect(api.guestInvites).not.toHaveBeenCalled();
  });
});
