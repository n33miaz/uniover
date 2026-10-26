import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi, GuestInviteSummary, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { StepUpService } from '../../core/auth/step-up/step-up.service';
import { GuestsSection } from './guests-section';
import { PeopleApi } from './people-api';
import { TV_CONTROL_ONLY } from './people-permissions';

const PROBLEM = 'https://uniover.app/problems/';

const invite = (
  id: string,
  name: string,
  status = 'pending',
  permissions: string[] = [...TV_CONTROL_ONLY],
): GuestInviteSummary => ({
  id,
  displayName: name,
  status,
  createdAt: '2026-10-19T12:00:00Z',
  expiresAt: '2026-10-21T12:00:00Z',
  usedAt: null,
  revokedAt: null,
  permissions,
});
const guest = (
  id: string,
  name: string,
  disabledAt: string | null = null,
  permissions: string[] = [...TV_CONTROL_ONLY],
): GuestSummary => ({
  id,
  displayName: name,
  email: `${name.toLowerCase()}@exemplo.com`,
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt,
  permissions,
});

type Fixture = ComponentFixture<GuestsSection>;

const SECRET = 'SegredoDoConvite0123456789abcdefghijklmnopq';

describe('GuestsSection', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    guestInvites: vi.fn(),
    guests: vi.fn(),
    revokeGuestInvite: vi.fn(),
    revokeGuest: vi.fn(),
    sessions: vi.fn(),
  };
  const people = { createInvite: vi.fn(), setPermissions: vi.fn() };
  const stepUp = { confirm: vi.fn() };

  const created = (name = 'Dani', permissions: string[] = [...TV_CONTROL_ONLY]) => ({
    id: 'i3',
    displayName: name,
    token: SECRET,
    expiresAt: '2026-10-22T12:00:00Z',
    permissions,
  });

  beforeEach(() => {
    for (const fn of [...Object.values(api), ...Object.values(people), stepUp.confirm]) {
      fn.mockReset();
    }
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockResolvedValue({
      id: '1',
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
    api.guestInvites.mockResolvedValue([
      invite('i1', 'Alice'),
      invite('i2', 'Velha', 'expired'),
      invite('i4', 'Raphael', 'pending', ['module:training']),
    ]);
    api.guests.mockResolvedValue([guest('g1', 'Bia'), guest('g2', 'Caio', '2026-10-20T10:00:00Z')]);
    people.createInvite.mockResolvedValue(created());
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthApi, useValue: api },
        { provide: PeopleApi, useValue: people },
        { provide: StepUpService, useValue: stepUp },
      ],
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  });

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(GuestsSection);
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => expect(api.guests).toHaveBeenCalled());
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const button = (el: HTMLElement, label: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
    );
  const type = (el: HTMLElement, selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = (el: HTMLElement) =>
    el.querySelector('form.invite')!.dispatchEvent(new Event('submit', { cancelable: true }));

  /** Abre o cartão de convite e digita o nome. */
  async function startInvite(fixture: Fixture, el: HTMLElement, name = 'Dani') {
    button(el, 'Convidar alguém')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    type(el, '#guest-name', name);
    await fixture.whenStable();
    fixture.detectChanges();
  }
  async function openPermissions(fixture: Fixture, el: HTMLElement) {
    el.querySelector<HTMLButtonElement>('.perms-toggle')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const flip = async (fixture: Fixture, el: HTMLElement, text: string) => {
    Array.from(el.querySelectorAll<HTMLElement>('label.option'))
      .find((row) => row.querySelector('.option-title')?.textContent?.trim() === text)!
      .querySelector('input')!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  describe('the list', () => {
    it('shows who has access first, then the pending invites, and drops invites that are not pending', async () => {
      const { el } = await render();
      const names = Array.from(el.querySelectorAll('.name')).map((n) => n.textContent);
      expect(names).toEqual(['Bia', 'Caio', 'Alice', 'Raphael']);
      expect(el.textContent).toContain('Vale até');
      expect(el.textContent).toContain('bia@exemplo.com');
      expect(el.querySelector('.subhead')?.textContent).toContain('Convites pendentes');
    });

    it('summarizes what each person and each pending invite can do, in plain words', async () => {
      const { el } = await render();
      const summaries = Array.from(el.querySelectorAll('.abilities')).map((n) => n.textContent);
      // Bia (a TV de sempre), Alice (a TV de sempre) e Raphael (só o Treino); quem foi revogado não tem resumo.
      expect(summaries).toEqual([
        'Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico',
        'Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico',
        'Usar o Treino',
      ]);
      expect(el.textContent).not.toMatch(/module:|tv:/);
    });

    it('marks a revoked person and offers nothing to edit on them', async () => {
      const { el } = await render();
      const rows = Array.from(el.querySelectorAll('.person'));
      const caio = rows.find((row) => row.textContent?.includes('Caio'))!;
      expect(caio.querySelector('.revoked')?.textContent).toContain('Acesso revogado');
      expect(caio.querySelectorAll('button')).toHaveLength(0);
      expect(caio.querySelector('.abilities')).toBeNull();
    });

    it('offers Permissões and revoking for someone who still has access', async () => {
      const { el } = await render();
      const bia = Array.from(el.querySelectorAll('.person')).find((row) =>
        row.textContent?.includes('Bia'),
      )!;
      expect(Array.from(bia.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual([
        'Sessões',
        'Permissões',
        'Revogar acesso',
      ]);
      const permissions = Array.from(bia.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Permissões',
      );
      expect(permissions?.getAttribute('aria-label')).toBe('Permissões de Bia');
    });

    it('opens the sessions of the person only on demand, through the administrator route', async () => {
      api.sessions.mockResolvedValue([]);
      const { fixture, el } = await render();
      expect(api.sessions).not.toHaveBeenCalled();
      const bia = Array.from(el.querySelectorAll('.person')).find((row) =>
        row.textContent?.includes('Bia'),
      )!;
      const toggle = Array.from(bia.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Sessões',
      )!;
      toggle.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(api.sessions).toHaveBeenCalledWith('t', 'g1');
      expect(bia.textContent).toContain('Sessões de Bia');
    });

    it('draws no empty block: with no pending invite there is no pending heading and no empty line', async () => {
      api.guestInvites.mockResolvedValue([]);
      const { el } = await render();
      expect(el.querySelector('.subhead')).toBeNull();
      expect(el.querySelector('.empty')).toBeNull();
      expect(el.textContent).not.toContain('Nenhum convite pendente');
    });

    it('draws no empty line for the guests when only invites exist', async () => {
      api.guests.mockResolvedValue([]);
      const { el } = await render();
      expect(el.querySelector('.empty')).toBeNull();
      expect(Array.from(el.querySelectorAll('.name')).map((n) => n.textContent)).toEqual([
        'Alice',
        'Raphael',
      ]);
    });

    it('says once that nobody was invited, when there is nobody at all', async () => {
      api.guests.mockResolvedValue([]);
      api.guestInvites.mockResolvedValue([]);
      const { el } = await render();
      expect(el.querySelectorAll('.empty')).toHaveLength(1);
      expect(el.querySelector('.empty')?.textContent).toContain('Ninguém foi convidado ainda.');
    });

    it('says so when the lists cannot be loaded', async () => {
      api.guests.mockRejectedValue(new ApiProblem(500, '', 'x'));
      const { el } = await render();
      expect(el.textContent).toContain('Não foi possível carregar os convidados');
    });
  });

  describe('inviting someone', () => {
    it('starts as a single primary button; the form only opens after it is pressed', async () => {
      const { fixture, el } = await render();
      expect(el.querySelector('form.invite')).toBeNull();
      expect(button(el, 'Convidar alguém')!.classList.contains('primary')).toBe(true);
      button(el, 'Convidar alguém')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('form.invite')).not.toBeNull();
      expect(button(el, 'Convidar alguém')).toBeUndefined();
      expect(el.querySelector('#guest-name')).not.toBeNull();
    });

    it('keeps the permissions folded behind "O que essa pessoa poderá fazer", with the summary in view', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      const toggle = el.querySelector<HTMLButtonElement>('.perms-toggle')!;
      expect(toggle.textContent).toContain('O que essa pessoa poderá fazer');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).toContain(
        'Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico',
      );
      expect(el.querySelector('app-people-permission-picker')).toBeNull();

      await openPermissions(fixture, el);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(el.querySelector('app-people-permission-picker')).not.toBeNull();
    });

    it('does not submit without a name', async () => {
      const { fixture, el } = await render();
      button(el, 'Convidar alguém')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(button(el, 'Gerar convite')!.disabled).toBe(true);
      submit(el);
      expect(people.createInvite).not.toHaveBeenCalled();
    });

    it('sends the model "only control the TV" by default, and shows the link once, with the secret in the fragment', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);

      await vi.waitFor(() =>
        expect(people.createInvite).toHaveBeenCalledWith('Dani', [...TV_CONTROL_ONLY]),
      );
      await fixture.whenStable();
      fixture.detectChanges();
      const link = el.querySelector<HTMLInputElement>('input.link')!;
      expect(link.value).toBe(`${window.location.origin}/convite#${SECRET}`);
      expect(el.textContent).toContain('serve uma vez só');
      // O formulário se recolhe e o botão de convidar espera o link ser fechado.
      expect(el.querySelector('form.invite')).toBeNull();
      expect(button(el, 'Convidar alguém')).toBeUndefined();
      expect(el.querySelector('.link-box .hint')?.textContent).toContain('Controlar a TV');
    });

    it('sends the model "only the Training" when it is chosen', async () => {
      people.createInvite.mockResolvedValue(created('Raphael', ['module:training']));
      const { fixture, el } = await render();
      await startInvite(fixture, el, 'Raphael');
      await openPermissions(fixture, el);
      Array.from(el.querySelectorAll<HTMLLabelElement>('label.model'))
        .find((label) => label.textContent?.trim() === 'Só o Treino')!
        .querySelector('input')!
        .click();
      await fixture.whenStable();
      fixture.detectChanges();
      submit(el);
      await vi.waitFor(() =>
        expect(people.createInvite).toHaveBeenCalledWith('Raphael', ['module:training']),
      );
    });

    it('sends a custom list, with "see the TV" brought along by the TV action', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      await openPermissions(fixture, el);
      Array.from(el.querySelectorAll<HTMLLabelElement>('label.model'))
        .find((label) => label.textContent?.trim() === 'Só o Treino')!
        .querySelector('input')!
        .click();
      await fixture.whenStable();
      await flip(fixture, el, 'Editar e reordenar atalhos');
      await flip(fixture, el, 'Usar o Treino');
      submit(el);
      await vi.waitFor(() =>
        expect(people.createInvite).toHaveBeenCalledWith('Dani', [
          'module:tv',
          'tv:edit-shortcuts',
        ]),
      );
    });

    it('will not create an invite that gives access to nothing, and says what to do', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      await openPermissions(fixture, el);
      await flip(fixture, el, 'Ver a TV');
      expect(button(el, 'Gerar convite')!.disabled).toBe(true);
      expect(el.querySelector('.summary')?.textContent).toContain(
        'Ligue ao menos a TV ou o Treino',
      );
      submit(el);
      expect(people.createInvite).not.toHaveBeenCalled();

      // Recolhido, o aviso continua à vista.
      await openPermissions(fixture, el);
      expect(el.querySelector('.perms-toggle')?.textContent).toContain('Ligue ao menos a TV');
    });

    it('cancelling closes the form and forgets the name and the choices', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      await openPermissions(fixture, el);
      await flip(fixture, el, 'Desligar a TV');
      button(el, 'Cancelar')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('form.invite')).toBeNull();

      await startInvite(fixture, el, '');
      expect((el.querySelector('#guest-name') as HTMLInputElement).value).toBe('');
      expect(el.querySelector('.perms-toggle')?.textContent).toContain('Desligar a TV');
    });

    it('a 403 means the passkey was not confirmed: says the invite was not created, and keeps the form', async () => {
      people.createInvite.mockRejectedValue(
        new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'identity.guest-invite'),
      );
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(el.querySelector('.message.error')).not.toBeNull());
      expect(el.querySelector('.message.error')?.textContent).toContain('O convite não foi criado');
      expect(el.querySelector('input.link')).toBeNull();
      expect(el.querySelector('form.invite')).not.toBeNull();
      expect((el.querySelector('#guest-name') as HTMLInputElement).value).toBe('Dani');
    });

    it.each([
      [new ApiProblem(409, 'too-many-invites', 'x'), 'convites pendentes demais'],
      [
        new ApiProblem(400, 'validation-failed', 'x'),
        'confira o nome e o que a pessoa poderá fazer',
      ],
      [new ApiProblem(429, 'rate-limited', 'x'), 'Muitas tentativas seguidas'],
      [new ApiProblem(0, 'network', 'x'), 'Sem conexão com o servidor'],
      [new ApiProblem(500, 'boom', 'x'), 'Não foi possível criar o convite agora'],
      [
        new HttpErrorResponse({
          status: 409,
          headers: new HttpHeaders(),
          error: { type: PROBLEM + 'too-many-invites', title: 'x' },
        }),
        'convites pendentes demais',
      ],
    ])('explains the error from the API (%#)', async (rejection, text) => {
      people.createInvite.mockRejectedValue(rejection);
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(el.querySelector('.message.error')).not.toBeNull());
      expect(el.querySelector('.message.error')?.textContent).toContain(text);
    });

    it('copies the link and closing it forgets the secret', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(button(el, 'Copiar link')).toBeDefined());
      await fixture.whenStable();
      fixture.detectChanges();

      button(el, 'Copiar link')!.click();
      await vi.waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/convite#${SECRET}`),
      );
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('.link-box .message')?.textContent).toContain('Link copiado');

      button(el, 'Fechar')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('input.link')).toBeNull();
      expect(el.textContent).not.toContain(SECRET);
      expect(button(el, 'Convidar alguém')).toBeDefined();
    });

    it('says so when the browser cannot copy', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(button(el, 'Copiar link')).toBeDefined());
      button(el, 'Copiar link')!.click();
      await vi.waitFor(() => expect(el.querySelector('.link-box .message.error')).not.toBeNull());
      expect(el.querySelector('.link-box .message.error')?.textContent).toContain(
        'Não deu para copiar sozinho',
      );
    });

    it('offers to share only where the browser can', async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(button(el, 'Compartilhar')).toBeDefined());
      button(el, 'Compartilhar')!.click();
      await vi.waitFor(() => expect(share).toHaveBeenCalled());
      expect(share.mock.calls[0][0].url).toContain('/convite#');
    });

    it('does not offer to share where the browser cannot', async () => {
      const { fixture, el } = await render();
      await startInvite(fixture, el);
      submit(el);
      await vi.waitFor(() => expect(button(el, 'Copiar link')).toBeDefined());
      expect(button(el, 'Compartilhar')).toBeUndefined();
    });
  });

  describe('revoking', () => {
    it('revokes a pending invite after a confirming click, then reloads', async () => {
      api.revokeGuestInvite.mockResolvedValue(undefined);
      const { fixture, el } = await render();
      button(el, 'Revogar')!.click();
      fixture.detectChanges();
      api.guestInvites.mockResolvedValue([]);
      button(el, 'Revogar')!.click();
      await vi.waitFor(() => expect(api.revokeGuestInvite).toHaveBeenCalledWith('t', 'i1'));
      await vi.waitFor(() => expect(el.textContent).toContain('Convite revogado.'));
    });

    it('revokes a guest only after the question, which does not talk about the TV only', async () => {
      api.revokeGuest.mockResolvedValue(undefined);
      const { fixture, el } = await render();
      button(el, 'Revogar acesso')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.question')?.textContent).toContain('poucos minutos');
      expect(el.querySelector('.question')?.textContent).not.toContain('TV');
      expect(api.revokeGuest).not.toHaveBeenCalled();
      button(el, 'Revogar acesso')!.click();
      await vi.waitFor(() => expect(api.revokeGuest).toHaveBeenCalledWith('t', 'g1'));
    });

    it('only offers to revoke a guest who still has access', async () => {
      const { el } = await render();
      expect(
        Array.from(el.querySelectorAll('button')).filter(
          (b) => b.textContent?.trim() === 'Revogar acesso',
        ),
      ).toHaveLength(1);
    });
  });

  describe('changing the permissions of someone who already joined', () => {
    const permissionsButton = (el: HTMLElement, name: string) =>
      el.querySelector<HTMLButtonElement>(`button[aria-label="Permissões de ${name}"]`)!;

    async function openSheet(fixture: Fixture, el: HTMLElement) {
      permissionsButton(el, 'Bia').click();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('opens the sheet for that person with what they have today', async () => {
      const { fixture, el } = await render();
      await openSheet(fixture, el);
      const sheet = el.querySelector('app-people-permissions-sheet')!;
      expect(sheet.querySelector('h2')?.textContent).toBe('Permissões de Bia');
      expect(sheet.querySelector('dialog')?.hasAttribute('open')).toBe(true);
      const on = Array.from(sheet.querySelectorAll<HTMLInputElement>('label.option input'))
        .map((input, index) => (input.checked ? index : -1))
        .filter((index) => index >= 0);
      expect(on).toEqual([0, 1, 2, 3, 5]);
    });

    it('saves the whole list, updates the row at once and says when it takes effect', async () => {
      people.setPermissions.mockImplementation(async (id: string, permissions: string[]) => ({
        ...guest(id, 'Bia'),
        permissions,
      }));
      const { fixture, el } = await render();
      await openSheet(fixture, el);
      await flip(fixture, el, 'Usar o Treino');
      el.querySelector('app-people-permissions-sheet form')!.dispatchEvent(
        new Event('submit', { cancelable: true }),
      );

      await vi.waitFor(() =>
        expect(people.setPermissions).toHaveBeenCalledWith('g1', [
          ...TV_CONTROL_ONLY,
          'module:training',
        ]),
      );
      await vi.waitFor(() => expect(el.querySelector('app-people-permissions-sheet')).toBeNull());
      fixture.detectChanges();
      const bia = Array.from(el.querySelectorAll('.person')).find((row) =>
        row.textContent?.includes('Bia'),
      )!;
      expect(bia.querySelector('.abilities')?.textContent).toContain('Usar o Treino');
      expect(el.querySelector('.messages .message')?.textContent).toContain(
        'Permissões de Bia salvas',
      );
      expect(el.querySelector('.messages .message')?.textContent).toContain('até 30 segundos');
      // Nenhuma leitura extra da lista: a linha já mostra o que a API devolveu.
      expect(api.guests).toHaveBeenCalledTimes(1);
    });

    it('closes without asking anything when cancelled, and gives the focus back to the button that opened it', async () => {
      const { fixture, el } = await render();
      await openSheet(fixture, el);
      button(el, 'Cancelar')!.click();
      await vi.waitFor(() => expect(el.querySelector('app-people-permissions-sheet')).toBeNull());
      expect(people.setPermissions).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(document.activeElement).toBe(permissionsButton(el, 'Bia')));
    });

    it('reads the list again when the API says the person is gone', async () => {
      people.setPermissions.mockRejectedValue(
        new HttpErrorResponse({
          status: 409,
          error: { type: PROBLEM + 'guest-revoked', title: 'x' },
        }),
      );
      const { fixture, el } = await render();
      await openSheet(fixture, el);
      await flip(fixture, el, 'Usar o Treino');
      el.querySelector('app-people-permissions-sheet form')!.dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await vi.waitFor(() => expect(api.guests).toHaveBeenCalledTimes(2));
      expect(el.querySelector('app-people-permissions-sheet .error')?.textContent).toContain(
        'já foi revogado',
      );
    });
  });

  describe('who may load it', () => {
    async function mount() {
      await TestBed.inject(AuthService).init();
      const fixture = TestBed.createComponent(GuestsSection);
      await fixture.whenStable();
      fixture.detectChanges();
      // Dá tempo de qualquer carregamento (indevido) acontecer antes de conferir.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fixture;
    }

    it('never calls the administrator route for a guest', async () => {
      api.me.mockResolvedValue({ id: '2', email: 'a@b.c', displayName: 'Alice', role: 'guest' });
      await mount();
      expect(api.guests).not.toHaveBeenCalled();
    });

    it('waits for the role while it is unknown (session to confirm) and loads when it arrives', async () => {
      api.refresh.mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'));
      const fixture = await mount();
      expect(api.guests).not.toHaveBeenCalled();
      // A sessão é confirmada depois: o papel chega e só então a lista é pedida.
      api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      await TestBed.inject(AuthService).renew();
      await fixture.whenStable();
      await vi.waitFor(() => expect(api.guests).toHaveBeenCalled());
    });
  });
});
