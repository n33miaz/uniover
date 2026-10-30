import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi, PasskeySummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { StepUpService } from '../../core/auth/step-up/step-up.service';
import { SecuritySection } from './security-section';

const passkey = (id: string, name: string, lastUsedAt: string | null = null): PasskeySummary => ({
  id,
  name,
  createdAt: '2026-10-01T12:00:00Z',
  lastUsedAt,
});

function fakeAttestation(): PublicKeyCredential {
  const buffer = (...values: number[]) => new Uint8Array(values).buffer;
  return {
    id: 'cred',
    rawId: buffer(1),
    type: 'public-key',
    response: {
      attestationObject: buffer(2),
      clientDataJSON: buffer(3),
      getTransports: () => ['internal'],
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

describe('SecuritySection', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    passkeys: vi.fn(),
    registrationOptions: vi.fn(),
    registrationComplete: vi.fn(),
    renamePasskey: vi.fn(),
    removePasskey: vi.fn(),
  };
  const stepUp = { confirm: vi.fn() };
  const create = vi.fn();

  beforeEach(() => {
    for (const fn of [...Object.values(api), stepUp.confirm, create]) fn.mockReset();
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'A' });
    api.passkeys.mockResolvedValue([passkey('p1', 'iPhone', '2026-10-10T08:00:00Z')]);
    api.registrationOptions.mockResolvedValue({
      challengeId: 'c-1',
      options: {
        rp: { name: 'UniOver', id: 'localhost' },
        user: { id: 'AQID', name: 'a@b.c', displayName: 'A' },
        challenge: 'BAUG',
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    });
    api.registrationComplete.mockResolvedValue(passkey('p2', 'Galaxy'));
    create.mockResolvedValue(fakeAttestation());
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    Object.defineProperty(navigator, 'credentials', {
      value: { create, get: vi.fn() },
      configurable: true,
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthApi, useValue: api },
        { provide: StepUpService, useValue: stepUp },
      ],
    });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['PublicKeyCredential'];
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
  });

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(SecuritySection);
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => expect(api.passkeys).toHaveBeenCalled());
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

  it('explains that the passkey only confirms dangerous actions and does not log in', async () => {
    const { el } = await render();
    expect(el.querySelector('.hint')?.textContent).toContain('só confirma ações sensíveis');
    expect(el.querySelector('.hint')?.textContent).toContain('por e-mail e senha');
  });

  it('lists the passkeys with dates and recommends having at least two', async () => {
    const { el } = await render();
    expect(el.querySelector('.name')?.textContent).toBe('iPhone');
    expect(el.textContent).toContain('Criada em');
    expect(el.textContent).toContain('Último uso em');
    expect(el.querySelector('.recommend')?.textContent).toContain('ao menos duas passkeys');
  });

  it('stops recommending once there are two', async () => {
    api.passkeys.mockResolvedValue([passkey('p1', 'iPhone'), passkey('p2', 'Galaxy')]);
    const { el } = await render();
    expect(el.querySelector('.recommend')).toBeNull();
    expect(el.textContent).toContain('Ainda não usada');
  });

  it('registers a passkey: asks for the password, creates the credential, completes and reloads', async () => {
    const { fixture, el } = await render();
    button(el, 'Cadastrar passkey')!.click();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('#passkey-password')!.autocomplete).toBe(
      'current-password',
    );
    type(el, '#passkey-password', 'minha-senha');
    type(el, '#passkey-name', 'Galaxy');
    fixture.detectChanges();
    api.passkeys.mockResolvedValue([passkey('p1', 'iPhone'), passkey('p2', 'Galaxy')]);
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(api.registrationComplete).toHaveBeenCalled());
    expect(api.registrationOptions).toHaveBeenCalledWith('t', 'minha-senha');
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.registrationComplete).toHaveBeenCalledWith(
      't',
      'c-1',
      'Galaxy',
      expect.objectContaining({ id: 'cred', rawId: 'AQ' }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Passkey cadastrada.');
    expect(el.querySelectorAll('.item')).toHaveLength(2);
    expect(el.querySelector('form.add')).toBeNull();
  });

  it('shows a clear message when the password is wrong', async () => {
    api.registrationOptions.mockRejectedValue(new ApiProblem(403, 'invalid-password', 'x'));
    const { fixture, el } = await render();
    button(el, 'Cadastrar passkey')!.click();
    fixture.detectChanges();
    type(el, '#passkey-password', 'errada');
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(el.textContent).toContain('Senha incorreta.'));
    expect(create).not.toHaveBeenCalled();
    expect(stepUp.confirm).not.toHaveBeenCalled();
  });

  it('shows a clear message when the authenticator prompt is cancelled', async () => {
    create.mockRejectedValue(new DOMException('x', 'NotAllowedError'));
    const { fixture, el } = await render();
    button(el, 'Cadastrar passkey')!.click();
    fixture.detectChanges();
    type(el, '#passkey-password', 'senha');
    el.querySelector('form.add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(el.textContent).toContain('cancelado ou demorou demais'));
    expect(api.registrationComplete).not.toHaveBeenCalled();
  });

  it('offers no registration on a device without WebAuthn', async () => {
    delete (window as unknown as Record<string, unknown>)['PublicKeyCredential'];
    const { el } = await render();
    expect(button(el, 'Cadastrar passkey')).toBeUndefined();
    expect(el.textContent).toContain('não oferece passkeys');
  });

  it('renames a passkey', async () => {
    api.renamePasskey.mockResolvedValue(passkey('p1', 'Meu iPhone'));
    const { fixture, el } = await render();
    button(el, 'Renomear')!.click();
    fixture.detectChanges();
    type(el, '#rename-p1', 'Meu iPhone');
    el.querySelector('form.inline')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(api.renamePasskey).toHaveBeenCalledWith('t', 'p1', 'Meu iPhone'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.name')?.textContent).toBe('Meu iPhone');
  });

  describe('removal', () => {
    it('asks for confirmation in the list first and does nothing if cancelled', async () => {
      const { fixture, el } = await render();
      button(el, 'Remover')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.question')?.textContent).toContain('Remover a passkey iPhone?');
      button(el, 'Cancelar')!.click();
      fixture.detectChanges();
      expect(api.removePasskey).not.toHaveBeenCalled();
      expect(el.querySelector('.question')).toBeNull();
    });

    it('goes through the passkey confirmation when the API asks for it, then removes', async () => {
      stepUp.confirm.mockResolvedValue(true);
      api.removePasskey
        .mockRejectedValueOnce(
          new ApiProblem(
            403,
            'step-up-required',
            'x',
            'step_up_required',
            'identity.passkey-remove',
          ),
        )
        .mockResolvedValueOnce(undefined);
      const { fixture, el } = await render();
      api.passkeys.mockResolvedValue([]);
      button(el, 'Remover')!.click();
      fixture.detectChanges();
      button(el, 'Remover')!.click();

      await vi.waitFor(() => expect(api.removePasskey).toHaveBeenCalledTimes(2));
      expect(stepUp.confirm).toHaveBeenCalledWith('identity.passkey-remove');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.textContent).toContain('Passkey removida.');
      expect(el.querySelectorAll('.item')).toHaveLength(0);
    });

    it('keeps the passkey when the confirmation is declined', async () => {
      stepUp.confirm.mockResolvedValue(false);
      api.removePasskey.mockRejectedValue(
        new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'identity.passkey-remove'),
      );
      const { fixture, el } = await render();
      button(el, 'Remover')!.click();
      fixture.detectChanges();
      button(el, 'Remover')!.click();
      await vi.waitFor(() => expect(el.textContent).toContain('não foi confirmada com a passkey'));
      expect(api.removePasskey).toHaveBeenCalledTimes(1);
      expect(el.querySelectorAll('.item')).toHaveLength(1);
    });

    it('explains that the last passkey cannot be removed', async () => {
      api.removePasskey.mockRejectedValue(new ApiProblem(409, 'last-passkey', 'x'));
      const { fixture, el } = await render();
      button(el, 'Remover')!.click();
      fixture.detectChanges();
      button(el, 'Remover')!.click();
      await vi.waitFor(() => expect(el.textContent).toContain('última passkey'));
    });
  });

  describe('who may load it', () => {
    async function mount() {
      await TestBed.inject(AuthService).init();
      const fixture = TestBed.createComponent(SecuritySection);
      await fixture.whenStable();
      fixture.detectChanges();
      // Dá tempo de qualquer carregamento (indevido) acontecer antes de conferir.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fixture;
    }

    it('never calls the administrator route for a guest', async () => {
      api.me.mockResolvedValue({ id: '2', email: 'a@b.c', displayName: 'Alice', role: 'guest' });
      await mount();
      expect(api.passkeys).not.toHaveBeenCalled();
    });

    it('waits for the role while it is unknown (session to confirm) and loads when it arrives', async () => {
      api.refresh.mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'));
      const fixture = await mount();
      expect(api.passkeys).not.toHaveBeenCalled();
      // A sessão é confirmada depois: o papel chega e só então a lista é pedida.
      api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
      await TestBed.inject(AuthService).renew();
      await fixture.whenStable();
      await vi.waitFor(() => expect(api.passkeys).toHaveBeenCalled());
    });
  });
});
