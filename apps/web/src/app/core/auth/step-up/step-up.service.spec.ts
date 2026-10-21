import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiProblem } from '../api-problem';
import { AuthApi } from '../auth-api';
import { AuthService } from '../auth.service';
import { StepUpService } from './step-up.service';

const OPTIONS = { challengeId: 'c-1', options: { challenge: 'AQID', rpId: 'localhost' } };

function fakeCredential(): PublicKeyCredential {
  const buffer = (...values: number[]) => new Uint8Array(values).buffer;
  return {
    id: 'cred',
    rawId: buffer(1),
    type: 'public-key',
    response: {
      authenticatorData: buffer(2),
      clientDataJSON: buffer(3),
      signature: buffer(4),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

describe('StepUpService', () => {
  const api = { stepUpOptions: vi.fn(), stepUpComplete: vi.fn() };
  const get = vi.fn();

  beforeEach(() => {
    api.stepUpOptions.mockReset().mockResolvedValue(OPTIONS);
    api.stepUpComplete
      .mockReset()
      .mockResolvedValue({ action: 'identity.passkey-remove', expiresAt: 'x' });
    get.mockReset().mockResolvedValue(fakeCredential());
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthApi, useValue: api },
        {
          provide: AuthService,
          useValue: { authorized: (call: (token: string) => Promise<unknown>) => call('tok') },
        },
      ],
    });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['PublicKeyCredential'];
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
    document.body.querySelectorAll('app-step-up-dialog').forEach((el) => el.remove());
  });

  const service = () => TestBed.inject(StepUpService);
  const stable = () => TestBed.inject(ApplicationRef).whenStable();
  const dialog = () => document.querySelector('app-step-up-dialog');
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('app-step-up-dialog button')).find(
      (b) => b.textContent?.trim() === label,
    );

  async function open(action = 'identity.passkey-remove') {
    const result = service().confirm(action);
    await vi.waitFor(() => expect(service().phase()).not.toBe('preparing'));
    await stable();
    return result;
  }

  it('opens an accessible dialog with Cancelar and Confirmar and no close button', async () => {
    const result = open();
    await vi.waitFor(() => expect(button('Confirmar')?.disabled).toBe(false));
    const element = dialog()!.querySelector('dialog')!;
    expect(element.getAttribute('aria-labelledby')).toBe('step-up-title');
    expect(dialog()!.querySelector('#step-up-title')?.textContent).toBe('Confirmar com passkey');
    expect(
      Array.from(dialog()!.querySelectorAll('button')).map((b) => b.textContent?.trim()),
    ).toEqual(['Cancelar', 'Confirmar']);
    expect(dialog()!.textContent).toContain('remover uma passkey');
    service().cancel();
    await result;
  });

  it('titles and words the dialog for a permissions change, asking the API for that very action', async () => {
    const result = open('identity.permissions-change');
    await vi.waitFor(() => expect(button('Confirmar')?.disabled).toBe(false));
    expect(dialog()!.querySelector('#step-up-title')?.textContent).toBe(
      'Confirmar a mudança de permissões',
    );
    expect(dialog()!.textContent).toContain('Para mudar as permissões de uma pessoa, confirme');
    expect(api.stepUpOptions).toHaveBeenCalledWith('tok', 'identity.permissions-change');
    service().cancel();
    await result;
  });

  it('fetches the challenge when the dialog opens, not when Confirmar is pressed', async () => {
    const result = open();
    await vi.waitFor(() =>
      expect(api.stepUpOptions).toHaveBeenCalledWith('tok', 'identity.passkey-remove'),
    );
    expect(get).not.toHaveBeenCalled();
    service().cancel();
    await result;
  });

  it('confirms with the passkey: get, then complete, then resolves true and removes the dialog', async () => {
    const result = open();
    await vi.waitFor(() => expect(button('Confirmar')?.disabled).toBe(false));
    button('Confirmar')!.click();
    await expect(result).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    const request = get.mock.calls[0][0] as CredentialRequestOptions;
    expect(request.publicKey?.userVerification).toBe('required');
    expect(api.stepUpComplete).toHaveBeenCalledWith(
      'tok',
      'c-1',
      expect.objectContaining({ id: 'cred', rawId: 'AQ' }),
    );
    expect(dialog()).toBeNull();
  });

  it('Cancelar resolves false and removes the dialog', async () => {
    const result = open();
    await vi.waitFor(() => expect(button('Cancelar')).toBeTruthy());
    button('Cancelar')!.click();
    await expect(result).resolves.toBe(false);
    expect(dialog()).toBeNull();
    expect(api.stepUpComplete).not.toHaveBeenCalled();
  });

  it('Esc (the cancel event of the dialog) also resolves false', async () => {
    const result = open();
    await vi.waitFor(() => expect(dialog()?.querySelector('dialog')).toBeTruthy());
    dialog()!
      .querySelector('dialog')!
      .dispatchEvent(new Event('cancel', { cancelable: true }));
    await expect(result).resolves.toBe(false);
  });

  it('without WebAuthn shows a clear message, offers only Cancelar and never starts', async () => {
    delete (window as unknown as Record<string, unknown>)['PublicKeyCredential'];
    const result = service().confirm('identity.passkey-remove');
    await stable();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('não oferece passkeys'));
    expect(button('Confirmar')).toBeUndefined();
    expect(api.stepUpOptions).not.toHaveBeenCalled();
    button('Cancelar')!.click();
    await expect(result).resolves.toBe(false);
  });

  it('without a registered passkey explains where to register one', async () => {
    api.stepUpOptions.mockRejectedValue(new ApiProblem(404, 'no-passkey', 'x'));
    const result = service().confirm('identity.passkey-remove');
    await vi.waitFor(() => expect(service().phase()).toBe('blocked'));
    await stable();
    expect(dialog()?.textContent).toContain('Nenhuma passkey cadastrada');
    expect(button('Confirmar')).toBeUndefined();
    service().cancel();
    await expect(result).resolves.toBe(false);
  });

  it('a cancelled authenticator prompt keeps the dialog open and allows another try', async () => {
    get.mockRejectedValueOnce(new DOMException('x', 'NotAllowedError'));
    const result = open();
    await vi.waitFor(() => expect(button('Confirmar')?.disabled).toBe(false));
    button('Confirmar')!.click();
    await vi.waitFor(() => expect(service().error()).toBe('cancelled'));
    await vi.waitFor(() => expect(service().phase()).toBe('ready'));
    await stable();
    expect(dialog()?.textContent).toContain('cancelada ou demorou demais');
    button('Confirmar')!.click();
    await expect(result).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('when the API refuses the passkey it fetches a fresh challenge for the next try', async () => {
    api.stepUpComplete.mockRejectedValueOnce(new ApiProblem(403, 'step-up-failed', 'x'));
    const result = open();
    await vi.waitFor(() => expect(button('Confirmar')?.disabled).toBe(false));
    button('Confirmar')!.click();
    await vi.waitFor(() => expect(service().error()).toBe('refused'));
    await vi.waitFor(() => expect(api.stepUpOptions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service().phase()).toBe('ready'));
    service().cancel();
    await result;
  });

  it('answers at once but lets the dialog go down before it leaves the page, then restores the focus and opens the next request', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const first = open('identity.passkey-remove');
    await vi.waitFor(() => expect(button('Cancelar')).toBeTruthy());

    let end!: () => void;
    const finished = new Promise<void>((resolve) => (end = resolve));
    const sheet = dialog()!.querySelector('dialog')!;
    sheet.getAnimations = () =>
      [
        { finished, effect: { getComputedTiming: () => ({ iterations: 1 }) } },
      ] as unknown as Animation[];

    button('Cancelar')!.click();
    await expect(first).resolves.toBe(false); // quem pediu já tem a resposta
    expect(sheet.classList.contains('closing')).toBe(true);
    expect(dialog()).not.toBeNull(); // ainda descendo
    expect(service().action()).toBe('identity.passkey-remove'); // o texto não muda no meio da saída

    const second = service().confirm('devices.pair-approve');
    await Promise.resolve();
    expect(document.querySelectorAll('app-step-up-dialog')).toHaveLength(1); // não empilha

    end();
    await vi.waitFor(() => expect(service().action()).toBe('devices.pair-approve'));
    expect(document.querySelectorAll('app-step-up-dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(opener); // o segundo diálogo guarda o foco certo
    service().cancel();
    await expect(second).resolves.toBe(false);
    opener.remove();
  });

  it('a second request waits for the dialog already open instead of stacking another', async () => {
    const first = open('identity.passkey-remove');
    await vi.waitFor(() => expect(service().phase()).toBe('ready'));
    const second = service().confirm('devices.pair-approve');
    expect(document.querySelectorAll('app-step-up-dialog')).toHaveLength(1);
    service().cancel();
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(service().action()).toBe('devices.pair-approve'));
    service().cancel();
    await expect(second).resolves.toBe(false);
  });
});
