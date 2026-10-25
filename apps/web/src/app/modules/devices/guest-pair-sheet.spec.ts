import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { DevicesApi } from './devices-api';
import { GuestPairSheet, PAIR_SELF_ACTION } from './guest-pair-sheet';

describe('GuestPairSheet', () => {
  const api = { approveOwn: vi.fn() };
  const authApi = { stepUpWithPassword: vi.fn() };
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    api.approveOwn.mockReset().mockImplementation(() => {
      calls.push('approve');
      return Promise.resolve();
    });
    authApi.stepUpWithPassword.mockReset().mockImplementation(() => {
      calls.push('password');
      return Promise.resolve({ action: PAIR_SELF_ACTION, expiresAt: '2026-10-24T12:00:00Z' });
    });
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
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Raphael',
      role: 'guest',
      permissions: ['module:tv'],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function render(code = 'bcdf2345') {
    const fixture = TestBed.createComponent(GuestPairSheet);
    fixture.componentRef.setInput('initialCode', code);
    const done = vi.fn();
    const closed = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    fixture.componentInstance.closed.subscribe(closed);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
    const type = (id: string, value: string) => {
      const input = field(id);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const submit = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    return { fixture, el, field, type, submit, done, closed };
  }

  it('comes with the code and a TV name made from the account, and asks for the password', async () => {
    const { field, submit } = await render();
    expect(field('guest-pair-code').value).toBe('BCDF-2345');
    expect(field('guest-pair-name').value).toBe('TV de Raphael');
    expect(field('guest-pair-password').type).toBe('password');
    expect(field('guest-pair-password').getAttribute('autocomplete')).toBe('current-password');
    // Sem a senha não aprova.
    expect(submit().disabled).toBe(true);
  });

  it('shows no choice of people: the TV is only his', async () => {
    const { el } = await render();
    expect(el.querySelector('input[role="switch"]')).toBeNull();
    expect(el.textContent).not.toContain('Para quem é a TV');
  });

  it('confirms the password first and then approves his own PC with the TV name', async () => {
    const { fixture, type, submit, done } = await render();
    type('guest-pair-password', 'minha-senha-123');
    expect(submit().disabled).toBe(false);
    submit().click();
    await vi.waitFor(() => expect(api.approveOwn).toHaveBeenCalled());

    expect(authApi.stepUpWithPassword).toHaveBeenCalledExactlyOnceWith(
      'token',
      'devices.pair-self',
      'minha-senha-123',
    );
    expect(api.approveOwn).toHaveBeenCalledExactlyOnceWith('BCDF2345', 'TV de Raphael');
    expect(calls).toEqual(['password', 'approve']);
    fixture.detectChanges();
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('does not approve when the password is wrong, and says so', async () => {
    authApi.stepUpWithPassword.mockRejectedValue(
      new ApiProblem(403, 'invalid-password', 'Senha incorreta.'),
    );
    const { fixture, el, type, submit, done } = await render();
    type('guest-pair-password', 'errada');
    submit().click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.error')?.textContent).toContain('Senha incorreta.');
    });
    expect(api.approveOwn).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('explains the limit of computers', async () => {
    api.approveOwn.mockRejectedValue(new ApiProblem(409, 'guest-agent-limit', 'limite'));
    const { fixture, el, type, submit } = await render();
    type('guest-pair-password', 'minha-senha-123');
    submit().click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.error')?.textContent).toContain(
        'Peça ao administrador para revogar um.',
      );
    });
  });

  it('says the code is invalid or expired on 404 and a network failure on status 0', async () => {
    api.approveOwn.mockRejectedValueOnce(new HttpErrorResponse({ status: 404 }));
    const { fixture, el, type, submit } = await render();
    type('guest-pair-password', 'minha-senha-123');
    submit().click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.error')?.textContent).toContain('Código inválido ou vencido.');
    });
    api.approveOwn.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    submit().click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.error')?.textContent).toContain('Sem conexão');
    });
  });

  it('cannot be submitted without a network', async () => {
    const { fixture, type, submit } = await render();
    type('guest-pair-password', 'minha-senha-123');
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(submit().disabled).toBe(true);
  });

  it('cancels without calling the API', async () => {
    const { fixture, el, closed } = await render();
    Array.from(el.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.trim() === 'Cancelar')!
      .click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect(authApi.stepUpWithPassword).not.toHaveBeenCalled();
    expect(api.approveOwn).not.toHaveBeenCalled();
  });
});
