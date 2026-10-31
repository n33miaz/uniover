import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { DevicesApi } from './devices-api';
import { PairOutcome, PairSheet } from './pair-sheet';

const PROBLEM = 'https://uniover.app/problems/';

function problem(status: number, kind: string, headers: Record<string, string> = {}) {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders(headers),
    error: { type: PROBLEM + kind, title: 'x' },
  });
}

describe('PairSheet', () => {
  const api = { approve: vi.fn(), deny: vi.fn(), list: vi.fn(), revoke: vi.fn() };
  const authApi = { guests: vi.fn() };
  const guest = (
    id: string,
    displayName: string,
    disabledAt: string | null = null,
  ): GuestSummary => ({
    id,
    displayName,
    disabledAt,
    pausedAt: null,
    email: `${id}@uniover.test`,
    createdAt: '2026-10-01T00:00:00Z',
    permissions: ['module:tv'],
  });

  beforeEach(() => {
    api.approve.mockReset().mockResolvedValue(undefined);
    api.deny.mockReset().mockResolvedValue(undefined);
    authApi.guests.mockReset().mockResolvedValue([]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DevicesApi, useValue: api },
        { provide: AuthApi, useValue: authApi },
        {
          provide: AuthService,
          useValue: { authorized: (call: (token: string) => unknown) => call('token') },
        },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(PairSheet);
    const outcomes: PairOutcome[] = [];
    let closed = 0;
    fixture.componentInstance.done.subscribe((o) => outcomes.push(o));
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const code = el.querySelector<HTMLInputElement>('#pair-code')!;
    const name = el.querySelector<HTMLInputElement>('#pair-name')!;
    const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
    const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
    const type = async (value: string) => {
      code.value = value;
      code.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    return { fixture, el, code, name, button, buttons, type, outcomes, closed: () => closed };
  }

  it('starts with the code from the link, normalized and ready to approve', async () => {
    const fixture = TestBed.createComponent(PairSheet);
    fixture.componentRef.setInput('initialCode', 'bcdf2345');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('#pair-code')!.value).toBe('BCDF-2345');
    const approve = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Aprovar',
    )!;
    expect(approve.disabled).toBe(false);
  });

  it('keeps an incomplete code from the link editable and not approvable', async () => {
    const fixture = TestBed.createComponent(PairSheet);
    fixture.componentRef.setInput('initialCode', 'bcdf');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('#pair-code')!.value).toBe('BCDF');
    const approve = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Aprovar',
    )!;
    expect(approve.disabled).toBe(true);
  });

  function clickBackdrop(dialog: HTMLDialogElement): void {
    Object.defineProperty(dialog, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 10, top: 10, right: 300, bottom: 500 }),
    });
    dialog.dispatchEvent(
      Object.assign(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }), {
        isPrimary: true,
      }),
    );
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
  }

  it('opens as a modal sheet without a close button and with the right input hints', async () => {
    const { el, code, name, buttons } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('pair-title');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('text');
    expect(code.getAttribute('autocapitalize')).toBe('characters');
    expect(name.value).toBe('PC de casa');
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      'Recusar código',
      'Cancelar',
      'Aprovar',
    ]);
  });

  it('masks the code while typing and keeps Aprovar disabled until it is valid', async () => {
    const { code, button, type } = await render();
    expect(button('Aprovar').disabled).toBe(true);
    await type('bcdf23');
    expect(code.value).toBe('BCDF-23');
    expect(button('Aprovar').disabled).toBe(true);
    await type('bcdf2345');
    expect(code.value).toBe('BCDF-2345');
    expect(button('Aprovar').disabled).toBe(false);
    expect(button('Recusar código').disabled).toBe(false);
    await type('ABCD2345'); // vogal
    expect(button('Aprovar').disabled).toBe(true);
  });

  it.each(['bcdf2345', 'BCDF-2345', 'bcdf 2345'])(
    'sends the normalized code when %j is typed',
    async (typed) => {
      const { button, type, outcomes } = await render();
      await type(typed);
      button('Aprovar').click();
      await vi.waitFor(() => expect(outcomes).toEqual([{ kind: 'approved', name: 'PC de casa' }]));
      expect(api.approve).toHaveBeenCalledExactlyOnceWith('BCDF2345', 'PC de casa', null, []);
    },
  );

  it('sends a null name when the field is left blank', async () => {
    const { name, button, type, outcomes } = await render();
    name.value = '   ';
    name.dispatchEvent(new Event('input'));
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => expect(outcomes).toEqual([{ kind: 'approved', name: null }]));
    expect(api.approve).toHaveBeenCalledWith('BCDF2345', null, null, []);
  });

  it('blocks an invalid name', async () => {
    const { el, name, button, type } = await render();
    await type('BCDF2345');
    name.value = '<b>';
    name.dispatchEvent(new Event('input'));
    TestBed.tick();
    expect(button('Aprovar').disabled).toBe(true);
    expect(el.textContent).toContain('Use letras, números, espaço');
  });

  it('explains an invalid or expired code (404) and stays open', async () => {
    api.approve.mockRejectedValue(problem(404, 'pairing-not-found'));
    const { fixture, el, button, type, outcomes } = await render();
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Código inválido ou vencido');
    });
    expect(outcomes).toEqual([]);
    expect(button('Aprovar').disabled).toBe(false);
  });

  it('tells how long to wait on 429', async () => {
    api.approve.mockRejectedValue(problem(429, 'rate-limited', { 'Retry-After': '42' }));
    const { fixture, el, button, type } = await render();
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Tente de novo em 42 s');
    });
  });

  it('says nothing was paired when the passkey confirmation was cancelled (403) and does not retry', async () => {
    api.approve.mockRejectedValue(
      new HttpErrorResponse({
        status: 403,
        error: {
          type: PROBLEM + 'step-up-required',
          title: 'x',
          code: 'step_up_required',
          action: 'tv.bind-agent',
        },
      }),
    );
    const { fixture, el, button, type, outcomes } = await render();
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('não foi confirmada com a passkey');
    });
    expect(outcomes).toEqual([]);
    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure', async () => {
    api.approve.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    const { fixture, el, button, type } = await render();
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Sem conexão com o servidor');
    });
  });

  describe('para quem é a TV', () => {
    it('lists the active accounts and sends the chosen ones, naming the TV after a single person', async () => {
      authApi.guests.mockResolvedValue([
        guest('g1', 'Raphael'),
        guest('g2', 'Ana', '2026-10-02T00:00:00Z'),
      ]);
      const { fixture, el, button, type, outcomes } = await render();
      fixture.detectChanges();
      const switches = Array.from(el.querySelectorAll<HTMLInputElement>('input[role="switch"]'));
      expect(switches).toHaveLength(1); // a conta desativada não aparece
      expect(el.textContent).toContain('Raphael');
      expect(el.textContent).not.toContain('Ana');

      switches[0].click();
      await type('BCDF2345');
      button('Aprovar').click();
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(api.approve).toHaveBeenCalledExactlyOnceWith(
        'BCDF2345',
        'PC de casa',
        'TV de Raphael',
        ['g1'],
      );
    });

    it('keeps the default TV name when more than one person is chosen', async () => {
      authApi.guests.mockResolvedValue([guest('g1', 'Raphael'), guest('g2', 'Ana')]);
      const { fixture, el, button, type, outcomes } = await render();
      fixture.detectChanges();
      el.querySelectorAll<HTMLInputElement>('input[role="switch"]').forEach((box) => box.click());
      await type('BCDF2345');
      button('Aprovar').click();
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(api.approve).toHaveBeenCalledExactlyOnceWith('BCDF2345', 'PC de casa', null, [
        'g1',
        'g2',
      ]);
    });

    it('blocks Aprovar while the list loads', async () => {
      let finish!: (list: GuestSummary[]) => void;
      authApi.guests.mockReturnValue(new Promise<GuestSummary[]>((resolve) => (finish = resolve)));
      const { fixture, el, button, type } = await render();
      await type('BCDF2345');
      fixture.detectChanges();
      expect(el.textContent).toContain('Carregando pessoas');
      expect(button('Aprovar').disabled).toBe(true);

      finish([]);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(button('Aprovar').disabled).toBe(false);
      });
    });

    it('shows a short error with Tentar de novo when the list fails, and never approves blind', async () => {
      authApi.guests.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
      const { fixture, el, button, type, outcomes } = await render();
      await type('BCDF2345');
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.textContent).toContain('Não foi possível carregar as pessoas');
      });
      expect(button('Aprovar').disabled).toBe(true);
      expect(api.approve).not.toHaveBeenCalled();

      authApi.guests.mockResolvedValue([guest('g1', 'Raphael')]);
      button('Tentar de novo').click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.textContent).toContain('Raphael');
      });
      expect(button('Aprovar').disabled).toBe(false);
      expect(outcomes).toEqual([]);
    });

    it('says only the administrator has an account when there is no one else', async () => {
      const { fixture, el } = await render();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.textContent).toContain('Só você tem conta por enquanto');
      });
    });
  });

  it('denies the code without asking for anything else', async () => {
    const { button, type, outcomes } = await render();
    await type('bcdf-2345');
    button('Recusar código').click();
    await vi.waitFor(() => expect(outcomes).toEqual([{ kind: 'denied' }]));
    expect(api.deny).toHaveBeenCalledExactlyOnceWith('BCDF2345');
    expect(api.approve).not.toHaveBeenCalled();
  });

  it('cancels with the button and with Esc', async () => {
    const withButton = await render();
    withButton.button('Cancelar').click();
    expect(withButton.closed()).toBe(1);

    const withEsc = await render();
    withEsc.el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(withEsc.closed()).toBe(1);

    const withBackdrop = await render();
    clickBackdrop(withBackdrop.el.querySelector('dialog')!);
    expect(withBackdrop.closed()).toBe(1);
  });

  it('closes before notifying the page and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { el, button, closed } = await render();

    button('Cancelar').click();

    expect(el.querySelector('dialog')!.open).toBe(false);
    expect(closed()).toBe(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  describe('exit', () => {
    /** Faz a folha achar que há uma transição de saída rodando, e devolve quem a encerra. */
    function slowExit(el: HTMLElement) {
      let end!: () => void;
      const finished = new Promise<void>((resolve) => (end = resolve));
      el.querySelector('dialog')!.getAnimations = () =>
        [
          { finished, effect: { getComputedTiming: () => ({ iterations: 1 }) } },
        ] as unknown as Animation[];
      return end;
    }

    it('goes down before telling the page it was approved, and no second action counts meanwhile', async () => {
      const { el, button, type, outcomes } = await render();
      const end = slowExit(el);
      await type('BCDF2345');
      button('Aprovar').click();
      await vi.waitFor(() =>
        expect(el.querySelector('dialog')!.classList.contains('closing')).toBe(true),
      );
      expect(outcomes).toEqual([]);
      expect(button('Aprovar').disabled).toBe(true);
      expect(button('Recusar código').disabled).toBe(true);
      expect(button('Cancelar').disabled).toBe(true);

      end();
      await vi.waitFor(() => expect(outcomes).toEqual([{ kind: 'approved', name: 'PC de casa' }]));
      expect(api.approve).toHaveBeenCalledTimes(1);
    });

    it('cancels once even when Cancelar and Esc come together', async () => {
      const { el, button, closed } = await render();
      const end = slowExit(el);
      button('Cancelar').click();
      el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      expect(closed()).toBe(0);
      end();
      await vi.waitFor(() => expect(closed()).toBe(1));
    });
  });

  it('disables every action without a network and explains why', async () => {
    const { fixture, el, button, type } = await render();
    await type('BCDF2345');
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(button('Aprovar').disabled).toBe(true);
    expect(button('Recusar código').disabled).toBe(true);
    expect(el.textContent).toContain('Sem conexão: isto precisa de rede.');
  });
});
