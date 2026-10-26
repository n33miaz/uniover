import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ApiProblem } from '../api-problem';
import { AuthApi } from '../auth-api';
import { AuthService } from '../auth.service';
import { QR_PANEL_CONFIG, QrLoginPanel } from './qr-login-panel';

describe('QrLoginPanel', () => {
  const api = { qrStart: vi.fn(), qrPoll: vi.fn() };
  const status = signal<'anonymous' | 'authenticated'>('anonymous');
  const auth = { init: vi.fn(), status, signInWithTokens: vi.fn() };
  const config = { pollMs: 1_000, backoffMs: 5_000, renewLeadMs: 2_000 };

  const started = (code: string, secret: string, expiresIn = 10) => ({
    code,
    pollSecret: secret,
    expiresAt: '2026-10-24T12:00:00Z',
    expiresIn,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    api.qrStart.mockReset();
    api.qrPoll.mockReset().mockResolvedValue({ status: 'pending' });
    auth.init.mockReset().mockResolvedValue(undefined);
    auth.signInWithTokens.mockReset().mockResolvedValue(undefined);
    status.set('anonymous');
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthApi, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: QR_PANEL_CONFIG, useValue: config },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render() {
    const fixture = TestBed.createComponent(QrLoginPanel);
    const signedIn = vi.fn();
    fixture.componentInstance.signedIn.subscribe(signedIn);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement, signedIn };
  }

  async function settle(fixture: { detectChanges: () => void }, ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('shows the QR with the link to the phone page and never puts the poll secret in it', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const { el } = await render();

    expect(el.querySelector('h2')?.textContent).toBe('Entrar com o celular');
    expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    expect(el.querySelector('app-qr-code svg')?.getAttribute('aria-label')).toBe(
      'QR para entrar pelo celular',
    );
    // O texto do QR é só o link com o código público.
    expect(el.innerHTML).not.toContain('segredo-de-consulta');
  });

  it('stays out of the way on a phone (no fine pointer) and for someone who already has a session', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const phone = await render();
    expect(api.qrStart).not.toHaveBeenCalled();
    expect(text(phone.el)).toBe('');

    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    status.set('authenticated');
    const signedAlready = await render();
    expect(api.qrStart).not.toHaveBeenCalled();
    expect(text(signedAlready.el)).toBe('');
  });

  it('polls with the secret, and on approval opens the session once and says so', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const { fixture, el, signedIn } = await render();

    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledWith('segredo-de-consulta');
    expect(signedIn).not.toHaveBeenCalled();

    api.qrPoll.mockResolvedValue({ status: 'approved', accessToken: 'jwt', expiresIn: 600 });
    await settle(fixture, 1_000);

    expect(auth.signInWithTokens).toHaveBeenCalledTimes(1);
    expect(auth.signInWithTokens).toHaveBeenCalledWith({ accessToken: 'jwt', expiresIn: 600 });
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(text(el)).toContain('Pronto, entrando');

    // Terminou: nenhuma consulta nem QR novo depois.
    const polls = api.qrPoll.mock.calls.length;
    await settle(fixture, 10_000);
    expect(api.qrPoll.mock.calls.length).toBe(polls);
    expect(api.qrStart).toHaveBeenCalledTimes(1);
  });

  it('renews the QR on its own shortly before it expires, with a new secret', async () => {
    api.qrStart
      .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro', 10))
      .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo', 10));
    const { fixture } = await render();

    await settle(fixture, 7_000);
    expect(api.qrStart).toHaveBeenCalledTimes(1);

    // Faltando menos que a margem (2 s) o QR é trocado, e a consulta passa a usar o segredo novo.
    await settle(fixture, 2_000);
    expect(api.qrStart).toHaveBeenCalledTimes(2);
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenLastCalledWith('segundo');
  });

  it('renews at once when the server says the request expired', async () => {
    api.qrStart
      .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
      .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'));
    api.qrPoll.mockResolvedValueOnce({ status: 'expired' });
    const { fixture } = await render();

    await settle(fixture, 1_000);

    expect(api.qrStart).toHaveBeenCalledTimes(2);
  });

  it('tells the person when the phone refused, and offers a new QR', async () => {
    api.qrStart
      .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
      .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'));
    api.qrPoll.mockResolvedValueOnce({ status: 'denied' });
    const { fixture, el } = await render();

    await settle(fixture, 1_000);
    expect(text(el)).toContain('Recusado no celular');
    expect(auth.signInWithTokens).not.toHaveBeenCalled();

    el.querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);
    expect(api.qrStart).toHaveBeenCalledTimes(2);
    expect(el.querySelector('app-qr-code')).not.toBeNull();
  });

  it('keeps the focus where it was when the retry buttons are pressed', async () => {
    // Sem isso o Safari tira o foco do campo de e-mail ao apertar, o erro dele aparece e empurra o botão antes de soltar.
    api.qrStart
      .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
      .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'));
    api.qrPoll.mockResolvedValueOnce({ status: 'denied' });
    const { fixture, el } = await render();
    const pressed = () => {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.querySelector<HTMLButtonElement>('button')!.dispatchEvent(down);
      return down.defaultPrevented;
    };

    expect(text(el)).toContain('Não foi possível gerar o QR');
    expect(pressed()).toBe(true);

    el.querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture, 1_000);
    expect(text(el)).toContain('Recusado no celular');
    expect(pressed()).toBe(true);
  });

  it('shows an error with a retry when the QR cannot be requested', async () => {
    api.qrStart.mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'));
    api.qrStart.mockResolvedValueOnce(started('CODE1234CODE1234', 'segredo'));
    const { fixture, el } = await render();

    expect(text(el)).toContain('Não foi possível gerar o QR');
    el.querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);

    expect(el.querySelector('app-qr-code')).not.toBeNull();
  });

  it('keeps trying through a network blip, and waits longer when the API asks for calm', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
    api.qrPoll
      .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
      .mockRejectedValueOnce(new ApiProblem(429, 'rate-limited', 'x'))
      .mockResolvedValue({ status: 'pending' });
    const { fixture } = await render();

    await settle(fixture, 1_000);
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(2);

    // Depois do 429 a próxima consulta espera o recuo (5 s), não 1 s.
    await settle(fixture, 4_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(2);
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(3);
  });

  it('does not poll while the tab is hidden', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { fixture } = await render();

    await settle(fixture, 5_000);
    expect(api.qrPoll).not.toHaveBeenCalled();

    hidden.mockReturnValue('visible');
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it('stops everything when the screen goes away', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
    const { fixture } = await render();

    fixture.destroy();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.qrPoll).not.toHaveBeenCalled();
    expect(api.qrStart).toHaveBeenCalledTimes(1);
  });

  describe('the wait between two polls', () => {
    it('leaves no timer pending when the screen goes away while it waits', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
      const idle = vi.getTimerCount();
      const { fixture } = await render();
      // Esperando a próxima consulta há um temporizador a mais do que antes de a tela nascer.
      expect(vi.getTimerCount()).toBe(idle + 1);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
    });

    it('also clears the longer wait that follows a request for calm from the API', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
      api.qrPoll.mockRejectedValueOnce(new ApiProblem(429, 'rate-limited', 'x'));
      const idle = vi.getTimerCount();
      const { fixture } = await render();

      await settle(fixture, 1_000);
      expect(api.qrPoll).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(idle + 1);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.qrPoll).toHaveBeenCalledTimes(1);
    });

    it('does not keep a timer going for a tab that stays hidden once the screen is gone', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      const idle = vi.getTimerCount();
      const { fixture } = await render();
      await settle(fixture, 3_000);
      expect(vi.getTimerCount()).toBe(idle + 1);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
      hidden.mockRestore();
    });

    it('keeps a single wait going when the QR is renewed, never one for each QR it showed', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro', 10))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo', 10));
      const idle = vi.getTimerCount();
      const { fixture } = await render();

      await settle(fixture, 9_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(idle + 1);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
    });
  });
});
