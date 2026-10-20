import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
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

  beforeEach(() => {
    api.approve.mockReset().mockResolvedValue(undefined);
    api.deny.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [{ provide: DevicesApi, useValue: api }] });
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
      expect(api.approve).toHaveBeenCalledExactlyOnceWith('BCDF2345', 'PC de casa');
    },
  );

  it('sends a null name when the field is left blank', async () => {
    const { name, button, type, outcomes } = await render();
    name.value = '   ';
    name.dispatchEvent(new Event('input'));
    await type('BCDF2345');
    button('Aprovar').click();
    await vi.waitFor(() => expect(outcomes).toEqual([{ kind: 'approved', name: null }]));
    expect(api.approve).toHaveBeenCalledWith('BCDF2345', null);
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
          action: 'devices.pair-approve',
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
    expect(el.textContent).toContain('Sem conexão: parear, recusar e revogar precisam de rede.');
  });
});
