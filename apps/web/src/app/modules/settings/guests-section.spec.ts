import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi, GuestInviteSummary, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { StepUpService } from '../../core/auth/step-up/step-up.service';
import { GuestsSection } from './guests-section';

const invite = (id: string, name: string, status = 'pending'): GuestInviteSummary => ({
  id,
  displayName: name,
  status,
  createdAt: '2026-10-19T12:00:00Z',
  expiresAt: '2026-10-21T12:00:00Z',
  usedAt: null,
  revokedAt: null,
  permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history'],
});
const guest = (id: string, name: string, disabledAt: string | null = null): GuestSummary => ({
  id,
  displayName: name,
  email: `${name.toLowerCase()}@exemplo.com`,
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt,
  permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history'],
});

const SECRET = 'SegredoDoConvite0123456789abcdefghijklmnopq';

describe('GuestsSection', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    guestInvites: vi.fn(),
    guests: vi.fn(),
    createGuestInvite: vi.fn(),
    revokeGuestInvite: vi.fn(),
    revokeGuest: vi.fn(),
  };
  const stepUp = { confirm: vi.fn() };

  beforeEach(() => {
    for (const fn of [...Object.values(api), stepUp.confirm]) fn.mockReset();
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockResolvedValue({
      id: '1',
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
    api.guestInvites.mockResolvedValue([invite('i1', 'Alice'), invite('i2', 'Velha', 'expired')]);
    api.guests.mockResolvedValue([guest('g1', 'Bia'), guest('g2', 'Caio', '2026-10-20T10:00:00Z')]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthApi, useValue: api },
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

  it('explains the guest idea: the TV only, a link handed over by the owner, a password the owner never sees', async () => {
    const { el } = await render();
    const hint = el.querySelector('.hint')?.textContent ?? '';
    expect(hint).toContain('controle da TV');
    expect(hint).toContain('você nunca vê');
  });

  it('lists only the pending invites and every guest, marking the revoked one', async () => {
    const { el } = await render();
    const names = Array.from(el.querySelectorAll('.name')).map((n) => n.textContent);
    expect(names).toEqual(['Alice', 'Bia', 'Caio']);
    expect(el.textContent).toContain('Vale até');
    expect(el.textContent).toContain('bia@exemplo.com');
    expect(el.querySelectorAll('.revoked')).toHaveLength(1);
  });

  it('creates an invite and shows the link once, with the secret in the fragment', async () => {
    api.createGuestInvite.mockResolvedValue({
      id: 'i3',
      displayName: 'Dani',
      token: SECRET,
      expiresAt: '2026-10-22T12:00:00Z',
    });
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(api.createGuestInvite).toHaveBeenCalledWith('t', 'Dani'));
    await fixture.whenStable();
    fixture.detectChanges();
    const link = el.querySelector<HTMLInputElement>('input.link')!;
    expect(link.value).toBe(`${window.location.origin}/convite#${SECRET}`);
    expect(el.textContent).toContain('serve uma vez só');
    expect(el.querySelector<HTMLInputElement>('#guest-name')!.value).toBe('');
  });

  it('the passkey confirmation is handled by the session: a 403 asks for it and repeats once', async () => {
    api.createGuestInvite
      .mockRejectedValueOnce(
        new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'identity.guest-invite'),
      )
      .mockResolvedValueOnce({
        id: 'i3',
        displayName: 'Dani',
        token: SECRET,
        expiresAt: '2026-10-22T12:00:00Z',
      });
    stepUp.confirm.mockResolvedValue(true);
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(api.createGuestInvite).toHaveBeenCalledTimes(2));
    expect(stepUp.confirm).toHaveBeenCalledWith('identity.guest-invite');
  });

  it('says the invite was not created when the confirmation is refused', async () => {
    api.createGuestInvite.mockRejectedValue(
      new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'identity.guest-invite'),
    );
    stepUp.confirm.mockResolvedValue(false);
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(el.querySelector('.message.error')).not.toBeNull());
    expect(el.querySelector('.message.error')?.textContent).toContain('O convite não foi criado');
    expect(el.querySelector('input.link')).toBeNull();
  });

  it('does not submit without a name', async () => {
    const { el } = await render();
    expect(button(el, 'Gerar convite')!.disabled).toBe(true);
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(api.createGuestInvite).not.toHaveBeenCalled();
  });

  it('explains the pending limit', async () => {
    api.createGuestInvite.mockRejectedValue(new ApiProblem(409, 'too-many-invites', 'x'));
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(el.querySelector('.message.error')).not.toBeNull());
    expect(el.querySelector('.message.error')?.textContent).toContain('convites pendentes demais');
  });

  it('copies the link and closing it forgets the secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api.createGuestInvite.mockResolvedValue({
      id: 'i3',
      displayName: 'Dani',
      token: SECRET,
      expiresAt: '2026-10-22T12:00:00Z',
    });
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(button(el, 'Copiar link')).toBeDefined());
    await fixture.whenStable();
    fixture.detectChanges();

    button(el, 'Copiar link')!.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/convite#${SECRET}`),
    );
    fixture.detectChanges();
    expect(el.querySelector('.message')?.textContent).toContain('Link copiado');

    button(el, 'Fechar')!.click();
    fixture.detectChanges();
    expect(el.querySelector('input.link')).toBeNull();
    expect(el.textContent).not.toContain(SECRET);
  });

  it('offers to share only where the browser can', async () => {
    api.createGuestInvite.mockResolvedValue({
      id: 'i3',
      displayName: 'Dani',
      token: SECRET,
      expiresAt: '2026-10-22T12:00:00Z',
    });
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const { fixture, el } = await render();
    type(el, '#guest-name', 'Dani');
    fixture.detectChanges();
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(button(el, 'Compartilhar')).toBeDefined());
    button(el, 'Compartilhar')!.click();
    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0].url).toContain('/convite#');
  });

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

  it('revokes a guest only after the question, and says it takes a few minutes', async () => {
    api.revokeGuest.mockResolvedValue(undefined);
    const { fixture, el } = await render();
    button(el, 'Revogar acesso')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.question')?.textContent).toContain('poucos minutos');
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

  it('says so when the lists cannot be loaded', async () => {
    api.guests.mockRejectedValue(new ApiProblem(500, '', 'x'));
    const { el } = await render();
    expect(el.textContent).toContain('Não foi possível carregar os convidados');
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
