import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ApiProblem } from '../api-problem';
import { AuthApi } from '../auth-api';
import { AuthService } from '../auth.service';
import { QR_PANEL_CONFIG, QrLoginPanel, QrPanelConfig } from './qr-login-panel';

describe('QrLoginPanel', () => {
  const api = { qrStart: vi.fn(), qrPoll: vi.fn() };
  const status = signal<'anonymous' | 'authenticated'>('anonymous');
  const auth = { init: vi.fn(), status, signInWithTokens: vi.fn() };
  // Com validade de 10 s e margem de 2 s, cada QR fica 8 s na tela antes da troca.
  const config: QrPanelConfig = {
    pollMs: 1_000,
    backoffMs: 5_000,
    renewLeadMs: 2_000,
    fallbackLifetimeMs: 20_000,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    quietFailures: 2,
    tickMs: 1_000,
  };

  const started = (code: string, secret: string, expiresIn = 10) => ({
    code,
    pollSecret: secret,
    expiresAt: '2026-10-24T12:00:00Z',
    expiresIn,
  });

  /** Computador com mouse (ponteiro preciso com `hover`). */
  function stubMedia() {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toNotFake: ['setImmediate', 'clearImmediate'] });
    stubMedia();
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
    vi.restoreAllMocks();
  });

  /** `open`: toca em "Entrar com o Celular" (quando o botão existe), que é o que pede o primeiro QR. */
  async function render(open = true) {
    const fixture = TestBed.createComponent(QrLoginPanel);
    const signedIn = vi.fn();
    fixture.componentInstance.signedIn.subscribe(signedIn);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    if (open) {
      openButton(el)?.click();
      await settle(fixture);
    }
    return { fixture, el, signedIn };
  }

  const openButton = (el: HTMLElement) => buttonNamed(el, 'Entrar com o Celular');
  const buttonNamed = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === name,
    );

  async function settle(fixture: { detectChanges: () => void }, ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const bar = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="progressbar"]');
  const barValue = (el: HTMLElement) => Number(bar(el)?.getAttribute('aria-valuenow'));
  const qrLink = (el: HTMLElement) =>
    el.querySelector('app-qr-code svg path')?.getAttribute('d') ?? null;

  function setVisibility(state: 'hidden' | 'visible') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('shows the QR with the link to the phone page and never puts the poll secret in it', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const { el } = await render();

    expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    expect(el.querySelector('app-qr-code svg')?.getAttribute('aria-label')).toBe(
      'QR para entrar pelo celular',
    );
    // O texto do QR é só o link com o código público.
    expect(el.innerHTML).not.toContain('segredo-de-consulta');
  });

  it('shows only the button and asks nothing of the server until it is tapped', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const { fixture, el } = await render(false);

    expect(fixture.componentInstance.visible()).toBe(true);
    expect(openButton(el)).toBeDefined();
    expect(el.querySelector('app-qr-code')).toBeNull();
    await settle(fixture, 30_000);
    expect(api.qrStart).not.toHaveBeenCalled();
    expect(api.qrPoll).not.toHaveBeenCalled();

    // Pelo teclado (foco no botão): o botão sai, e o foco vai para o "Fechar", que fica no lugar dele.
    openButton(el)!.focus();
    openButton(el)!.click();
    await settle(fixture);
    expect(api.qrStart).toHaveBeenCalledTimes(1);
    expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    expect(openButton(el)).toBeUndefined();
    expect(document.activeElement).toBe(buttonNamed(el, 'Fechar'));
  });

  it('leaves the focus in the field when the button is clicked with the mouse', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const field = document.body.appendChild(document.createElement('input'));
    try {
      const { fixture, el } = await render(false);
      field.focus();
      openButton(el)!.click(); // o mousedown do botão não tira o foco do campo
      await settle(fixture);
      expect(el.querySelector('app-qr-code')).not.toBeNull();
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  it('closing stops the polls and renewals, forgets the QR and brings the button back', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta', 60));
    const idle = vi.getTimerCount();
    const { fixture, el } = await render();
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(1);

    buttonNamed(el, 'Fechar')!.click();
    await settle(fixture);
    expect(el.querySelector('app-qr-code')).toBeNull();
    expect(openButton(el)).toBeDefined();
    expect(vi.getTimerCount()).toBe(idle);
    await settle(fixture, 120_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(1);
    expect(api.qrStart).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way on a phone (no fine pointer) and for someone who already has a session', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const phone = await render(false);
    expect(api.qrStart).not.toHaveBeenCalled();
    expect(text(phone.el)).toBe('');

    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    status.set('authenticated');
    const signedAlready = await render(false);
    expect(api.qrStart).not.toHaveBeenCalled();
    expect(text(signedAlready.el)).toBe('');
  });

  it('polls with the secret, and on approval opens the session once and stops everything', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo-de-consulta'));
    const idle = vi.getTimerCount();
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
    expect(bar(el)).toBeNull();
    expect(vi.getTimerCount()).toBe(idle);

    // Terminou: nenhuma consulta nem QR novo depois, nem quando a validade do QR passaria.
    const polls = api.qrPoll.mock.calls.length;
    await settle(fixture, 60_000);
    expect(api.qrPoll.mock.calls.length).toBe(polls);
    expect(api.qrStart).toHaveBeenCalledTimes(1);
  });

  describe('automatic renewal', () => {
    it('swaps the QR shortly before each expiry, cycle after cycle, with a new secret each time', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'))
        .mockResolvedValueOnce(started('THIRD890THIRD890', 'terceiro'));
      const { fixture, el } = await render();
      const first = qrLink(el);

      await settle(fixture, 7_000);
      expect(api.qrStart).toHaveBeenCalledTimes(1);

      // Faltando a margem (2 s) para os 10 s de validade, o QR é trocado sem nenhum toque.
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(qrLink(el)).not.toBe(first);
      await settle(fixture, 1_000);
      expect(api.qrPoll).toHaveBeenLastCalledWith('segundo');

      // E de novo no ciclo seguinte, contado a partir do QR novo.
      await settle(fixture, 7_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
      await settle(fixture, 1_000);
      expect(api.qrPoll).toHaveBeenLastCalledWith('terceiro');
    });

    it('uses the expiry the API returns, not a fixed guess', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 30));
      const { fixture } = await render();

      await settle(fixture, 27_000);
      expect(api.qrStart).toHaveBeenCalledTimes(1);
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
    });

    it('falls back to the expiry time, then to the configured lifetime, when the duration is unusable', async () => {
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      api.qrStart
        .mockResolvedValueOnce({
          ...started('CODE1234CODE1234', 'a', 0),
          expiresAt: '2026-10-24T12:00:12Z',
        })
        .mockResolvedValue({ ...started('OTHER567OTHER567', 'b', 0), expiresAt: 'inválido' });
      const { fixture } = await render();

      // 12 s pelo horário de vencimento: troca aos 10 s.
      await settle(fixture, 9_000);
      expect(api.qrStart).toHaveBeenCalledTimes(1);
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);

      // Sem nada legível: a validade de reserva (20 s), trocada aos 18 s.
      await settle(fixture, 17_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
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

    it('when the phone refuses, says so above a fresh QR instead of a dead end', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'))
        .mockResolvedValueOnce(started('THIRD890THIRD890', 'terceiro'));
      api.qrPoll.mockResolvedValueOnce({ status: 'denied' });
      const { fixture, el } = await render();

      await settle(fixture, 1_000);
      expect(text(el)).toContain('Recusado no celular');
      expect(auth.signInWithTokens).not.toHaveBeenCalled();
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
      expect(buttonNamed(el, 'Gerar Outro QR')).toBeUndefined();

      // Na troca seguinte o aviso sai.
      await settle(fixture, 8_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
      expect(text(el)).not.toContain('Recusado no celular');
    });
  });

  describe('the time bar', () => {
    it('is a labelled progress bar that drains until the swap and fills again with each new QR', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'));
      const { fixture, el } = await render();

      expect(bar(el)?.getAttribute('aria-label')).toBe('Tempo até o próximo QR');
      expect(bar(el)?.getAttribute('aria-valuemin')).toBe('0');
      expect(bar(el)?.getAttribute('aria-valuemax')).toBe('100');
      // Sem região viva: nada é anunciado a cada passo.
      expect(bar(el)?.getAttribute('aria-live')).toBeNull();
      expect(barValue(el)).toBe(100);
      expect(bar(el)?.getAttribute('aria-valuetext')).toBe('Novo QR em 8 s');

      await settle(fixture, 2_000);
      expect(barValue(el)).toBe(75);
      await settle(fixture, 4_000);
      expect(barValue(el)).toBe(25);
      expect(bar(el)?.getAttribute('aria-valuetext')).toBe('Novo QR em 2 s');

      await settle(fixture, 2_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(barValue(el)).toBe(100);
      await settle(fixture, 4_000);
      expect(barValue(el)).toBe(50);
    });

    it('draws the remaining time through a theme-free custom property', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo'));
      const { fixture, el } = await render();
      const fill = () =>
        el.querySelector<HTMLElement>('.timer-fill')!.style.getPropertyValue('--qr-left');

      expect(fill()).toBe('1');
      await settle(fixture, 4_000);
      expect(fill()).toBe('0.5');
    });
  });

  describe('a hidden tab', () => {
    it('pauses polls, renewals and the bar, and gets a fresh QR at once when it comes back stale', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'));
      const idle = vi.getTimerCount();
      const { fixture, el } = await render();
      await settle(fixture, 1_000);
      expect(api.qrPoll).toHaveBeenCalledTimes(1);
      const first = qrLink(el);

      setVisibility('hidden');
      expect(vi.getTimerCount()).toBe(idle);
      await settle(fixture, 30_000);
      expect(api.qrPoll).toHaveBeenCalledTimes(1);
      expect(api.qrStart).toHaveBeenCalledTimes(1);

      setVisibility('visible');
      await settle(fixture);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(qrLink(el)).not.toBe(first);
      expect(barValue(el)).toBe(100);
      await settle(fixture, 1_000);
      expect(api.qrPoll).toHaveBeenLastCalledWith('segundo');
    });

    it('keeps a QR that is still fresh and resumes from where it was', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'primeiro'));
      const { fixture, el } = await render();

      setVisibility('hidden');
      await settle(fixture, 2_000);
      setVisibility('visible');
      await settle(fixture);

      expect(api.qrStart).toHaveBeenCalledTimes(1);
      expect(api.qrPoll).toHaveBeenCalledTimes(1);
      expect(barValue(el)).toBe(75);
      await settle(fixture, 6_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
    });

    it('does not throw away an approval that arrives while the tab is hidden', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'primeiro'));
      let answer: (value: unknown) => void = () => undefined;
      api.qrPoll.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      const { fixture, signedIn } = await render();
      await settle(fixture, 1_000);

      setVisibility('hidden');
      answer({ status: 'approved', accessToken: 'jwt', expiresIn: 600 });
      await settle(fixture);
      expect(signedIn).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the QR cannot be requested', () => {
    it('retries quietly with growing waits, then shows the QR without ever flashing an error', async () => {
      api.qrStart
        .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
        .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'segredo'));
      const { fixture, el } = await render();

      expect(text(el)).not.toContain('Não foi possível');
      expect(el.querySelector('.ui-skeleton')).not.toBeNull();
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(text(el)).not.toContain('Não foi possível');

      // A segunda espera dobra (2 s).
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
      expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    });

    it('keeps the current QR on screen while a renewal fails and it is still valid', async () => {
      api.qrStart
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'primeiro'))
        .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
        .mockResolvedValueOnce(started('OTHER567OTHER567', 'segundo'));
      const { fixture, el } = await render();
      const first = qrLink(el);

      await settle(fixture, 8_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      expect(qrLink(el)).toBe(first);
      expect(text(el)).not.toContain('Não foi possível');

      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
      expect(qrLink(el)).not.toBe(first);
    });

    it('after several failures in a row, says so with a retry, and still keeps trying on its own', async () => {
      api.qrStart.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
      const { fixture, el } = await render();
      // Falhas: 1 (já), 2 (após 1 s), 3 (após mais 2 s): passa do tolerado (2).
      await settle(fixture, 1_000);
      expect(text(el)).not.toContain('Não foi possível');
      await settle(fixture, 2_000);
      expect(api.qrStart).toHaveBeenCalledTimes(3);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Não foi possível gerar o QR',
      );

      // A espera tem teto (4 s) e as tentativas seguem; quando a API volta, o QR aparece.
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo'));
      await settle(fixture, 4_000);
      expect(api.qrStart).toHaveBeenCalledTimes(4);
      expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    });

    it('lets the person retry at once from the error, and the retry button keeps the focus where it was', async () => {
      api.qrStart.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
      const { fixture, el } = await render();
      await settle(fixture, 3_000);
      const retry = buttonNamed(el, 'Tentar de Novo')!;
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      retry.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);

      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo'));
      retry.click();
      await settle(fixture);
      expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
    });

    it('waits at least the calm period when the API answers 429', async () => {
      api.qrStart
        .mockRejectedValueOnce(new ApiProblem(429, 'rate-limited', 'x'))
        .mockResolvedValueOnce(started('CODE1234CODE1234', 'segredo'));
      const { fixture } = await render();

      await settle(fixture, 4_000);
      expect(api.qrStart).toHaveBeenCalledTimes(1);
      await settle(fixture, 1_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps polling through a network blip, and waits longer when the API asks for calm', async () => {
    api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
    api.qrPoll
      .mockRejectedValueOnce(new ApiProblem(0, 'network', 'x'))
      .mockRejectedValueOnce(new ApiProblem(429, 'rate-limited', 'x'))
      .mockResolvedValue({ status: 'pending' });
    const { fixture, el } = await render();

    await settle(fixture, 1_000);
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(2);
    expect(text(el)).not.toContain('Não foi possível');

    // Depois do 429 a próxima consulta espera o recuo (5 s), não 1 s.
    await settle(fixture, 4_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(2);
    await settle(fixture, 1_000);
    expect(api.qrPoll).toHaveBeenCalledTimes(3);
  });

  describe('when the screen goes away', () => {
    it('stops listening to the tab', async () => {
      const remove = vi.spyOn(document, 'removeEventListener');
      const { fixture } = await render(false);
      fixture.destroy();
      expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('stops polling and renewing', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo', 60));
      const { fixture } = await render();

      fixture.destroy();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(api.qrPoll).not.toHaveBeenCalled();
      expect(api.qrStart).toHaveBeenCalledTimes(1);
    });

    it('leaves no timer behind: not the poll, not the bar, not a retry', async () => {
      api.qrStart.mockResolvedValue(started('CODE1234CODE1234', 'segredo'));
      const idle = vi.getTimerCount();
      const { fixture } = await render();
      await settle(fixture, 9_000);
      expect(api.qrStart).toHaveBeenCalledTimes(2);
      // Uma espera (consulta ou troca) e o relógio da barra, nunca um par por QR já mostrado.
      expect(vi.getTimerCount()).toBe(idle + 2);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
    });

    it('also clears a pending retry after a failure', async () => {
      api.qrStart.mockRejectedValue(new ApiProblem(429, 'rate-limited', 'x'));
      const idle = vi.getTimerCount();
      const { fixture } = await render();
      // A nova tentativa espera (o "gerando" da tela também pode ter os seus temporizadores).
      expect(vi.getTimerCount()).toBeGreaterThan(idle);

      fixture.destroy();
      expect(vi.getTimerCount()).toBe(idle);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.qrStart).toHaveBeenCalledTimes(1);
    });
  });

  it('holds the square of the QR as a busy skeleton while the code is requested, then swaps it for the QR', async () => {
    let finish: (value: ReturnType<typeof started>) => void = () => undefined;
    api.qrStart.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { fixture, el } = await render();

    const status = el.querySelector('app-loading-frame[aria-busy="true"]');
    expect(status).not.toBeNull();
    expect(el.querySelector('.ui-skeleton.square')).not.toBeNull();
    expect(el.querySelector('app-qr-code')).toBeNull();

    finish(started('CODE1234CODE1234', 'segredo-de-consulta'));
    await settle(fixture);
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
    expect(el.querySelector('.ui-skeleton')).toBeNull();
    expect(el.querySelector('app-qr-code svg path')).not.toBeNull();
  });
});
