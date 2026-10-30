import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiProblem } from '../api-problem';
import { AuthApi } from '../auth-api';
import { AuthService } from '../auth.service';
import { QrApprovePage } from './qr-approve.page';

const CODE = 'AbC_123-xyz45678';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('QrApprovePage', () => {
  const api = { qrInfo: vi.fn(), qrApprove: vi.fn(), qrDeny: vi.fn() };
  const auth = { authorized: vi.fn() };

  const info = (overrides: Record<string, unknown> = {}) => ({
    userAgent: CHROME_WINDOWS,
    sameNetwork: true,
    expiresAt: '2026-10-24T12:02:00Z',
    verification: 'none',
    ...overrides,
  });

  beforeEach(() => {
    api.qrInfo.mockReset().mockResolvedValue(info());
    api.qrApprove.mockReset().mockResolvedValue(undefined);
    api.qrDeny.mockReset().mockResolvedValue(undefined);
    auth.authorized
      .mockReset()
      .mockImplementation((call: (token: string) => Promise<unknown>) => call('tok'));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'entrar/qr', component: QrApprovePage }]),
        { provide: AuthApi, useValue: api },
        { provide: AuthService, useValue: auth },
      ],
    });
  });

  async function render(url = `/entrar/qr?codigo=${CODE}`) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
    const el = harness.routeNativeElement as HTMLElement;
    const settle = async () => {
      await harness.fixture.whenStable();
      harness.fixture.detectChanges();
    };
    return { el, settle };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === label)!;

  it('shows what is known about the computer, in one title and two lines, and asks for the confirmation', async () => {
    const { el } = await render();

    expect(api.qrInfo).toHaveBeenCalledWith('tok', CODE);
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('h1')?.textContent).toBe('Entrar no computador?');
    expect(text(el)).toContain('Chrome no Windows');
    expect(text(el)).toContain('Na mesma rede deste celular');
    expect(el.querySelector('.device-label')?.textContent).toBe('Computador');
    expect(el.querySelector('.network-label')?.textContent).toBe('Rede');
    expect(text(el)).toContain('Confirme só se foi você quem abriu o QR.');
    expect(button(el, 'Confirmar')).toBeTruthy();
    expect(button(el, 'Cancelar')).toBeTruthy();
    // Sessão recente: nenhuma senha a pedir.
    expect(el.querySelector('input[type="password"]')).toBeNull();
  });

  it('warns when the computer is on another network and names an unknown agent plainly', async () => {
    api.qrInfo.mockResolvedValue(info({ sameNetwork: false, userAgent: null }));
    const { el } = await render();

    expect(text(el)).toContain('Em outra rede');
    expect(text(el)).toContain('Computador desconhecido');
    expect(el.querySelector('li.warn')).not.toBeNull();
  });

  it('confirms, and the call goes through the authorized helper (which opens the passkey dialog when asked)', async () => {
    const { el, settle } = await render();

    button(el, 'Confirmar').click();
    await settle();

    expect(api.qrApprove).toHaveBeenCalledWith('tok', CODE, null);
    expect(auth.authorized).toHaveBeenLastCalledWith(expect.any(Function));
    expect(text(el)).toContain('Computador liberado');
    expect(text(el)).toContain('Ele já está entrando na sua conta.');
  });

  it('cancels with the deny call and says the computer did not get in', async () => {
    const { el, settle } = await render();

    button(el, 'Cancelar').click();
    await settle();

    expect(api.qrDeny).toHaveBeenCalledWith('tok', CODE);
    expect(api.qrApprove).not.toHaveBeenCalled();
    expect(text(el)).toContain('Entrada cancelada');
  });

  it('asks for the password when the session is old, refuses an empty one, and sends the typed one', async () => {
    api.qrInfo.mockResolvedValue(info({ verification: 'password' }));
    const { el, settle } = await render();
    const input = () => el.querySelector<HTMLInputElement>('#qr-password')!;

    button(el, 'Confirmar').click();
    await settle();
    expect(api.qrApprove).not.toHaveBeenCalled();
    expect(text(el)).toContain('Informe a sua senha.');

    input().value = 'minha-senha';
    input().dispatchEvent(new Event('input'));
    button(el, 'Confirmar').click();
    await settle();

    expect(api.qrApprove).toHaveBeenCalledWith('tok', CODE, 'minha-senha');
    expect(text(el)).toContain('Computador liberado');
  });

  it('shows a wrong password under the field, clears it and lets the person try again', async () => {
    api.qrInfo.mockResolvedValue(info({ verification: 'password' }));
    api.qrApprove.mockRejectedValueOnce(
      new ApiProblem(403, 'invalid-password', 'Senha incorreta.'),
    );
    const { el, settle } = await render();
    const input = () => el.querySelector<HTMLInputElement>('#qr-password')!;

    input().value = 'errada';
    input().dispatchEvent(new Event('input'));
    // O navegador desenha o que a pessoa digitou antes do toque no botão; sem isso o campo nunca "teve" a senha errada.
    await settle();
    button(el, 'Confirmar').click();
    await settle();

    expect(text(el)).toContain('Senha incorreta.');
    expect(input().value).toBe('');
    expect(el.querySelector('h1')?.textContent).toBe('Entrar no computador?');
  });

  it('reads the requirements again when the session got old between opening and confirming', async () => {
    api.qrApprove.mockRejectedValueOnce(new ApiProblem(403, 'qr-reauth-required', 'x'));
    const { el, settle } = await render();
    api.qrInfo.mockResolvedValue(info({ verification: 'password' }));

    button(el, 'Confirmar').click();
    await settle();

    expect(api.qrInfo).toHaveBeenCalledTimes(2);
    expect(el.querySelector('#qr-password')).not.toBeNull();
  });

  it('stays on the screen, with the button, when the passkey confirmation was cancelled', async () => {
    api.qrApprove.mockRejectedValueOnce(
      new ApiProblem(403, 'step-up-required', 'x', 'step_up_required', 'identity.qr-login-approve'),
    );
    const { el, settle } = await render();

    button(el, 'Confirmar').click();
    await settle();

    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(button(el, 'Confirmar').disabled).toBe(false);
  });

  it.each([
    ['no code in the link', '/entrar/qr', null],
    [
      'a code the server no longer knows',
      `/entrar/qr?codigo=${CODE}`,
      new ApiProblem(410, 'qr-invalid', 'x'),
    ],
    ['a code the server calls malformed', `/entrar/qr?codigo=x`, new ApiProblem(400, '', 'x')],
  ])('says the QR is no longer valid for %s', async (_label, url, failure) => {
    if (failure) api.qrInfo.mockRejectedValue(failure);
    const { el } = await render(url);

    expect(el.querySelector('h1')?.textContent).toBe('QR vencido');
    expect(text(el)).toContain('Peça outro na tela do computador.');
    expect(el.querySelector('button')).toBeNull();
  });

  it('says so when the QR could not be read at all (no connection)', async () => {
    api.qrInfo.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
    const { el } = await render();

    expect(el.querySelector('h1')?.textContent).toBe('Sem conexão');
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('says the QR expired when confirming a request that just expired', async () => {
    api.qrApprove.mockRejectedValueOnce(new ApiProblem(410, 'qr-invalid', 'x'));
    const { el, settle } = await render();

    button(el, 'Confirmar').click();
    await settle();

    expect(el.querySelector('h1')?.textContent).toBe('QR vencido');
  });
});
