import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { ResetPasswordPage } from './reset-password.page';

describe('ResetPasswordPage', () => {
  const api = { resetPassword: vi.fn() };
  const token = 'a'.repeat(43);

  beforeEach(() => {
    api.resetPassword.mockReset();
    history.replaceState(null, '', `/redefinir-senha#token=${token}`);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthApi, useValue: api }],
    });
  });

  afterEach(() => history.replaceState(null, '', '/'));

  async function render() {
    const fixture = TestBed.createComponent(ResetPasswordPage);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  function type(el: HTMLElement, id: string, value: string): void {
    const field = el.querySelector<HTMLInputElement>(`#${id}`)!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  }

  async function submit(fixture: ComponentFixture<ResetPasswordPage>, el: HTMLElement) {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('takes the secret out of the address and sends it only in the request body', async () => {
    api.resetPassword.mockResolvedValue(undefined);
    const { fixture, el } = await render();
    expect(location.hash).toBe('');
    type(el, 'reset-password', 'nova-senha-segura');
    type(el, 'reset-confirmation', 'nova-senha-segura');
    await submit(fixture, el);
    expect(api.resetPassword).toHaveBeenCalledWith(token, 'nova-senha-segura', undefined);
    expect(el.textContent).toContain('Senha alterada');
  });

  it('requests a second factor when the account has one', async () => {
    api.resetPassword.mockRejectedValueOnce(new ApiProblem(428, 'second-factor-required', 'x'));
    api.resetPassword.mockResolvedValueOnce(undefined);
    const { fixture, el } = await render();
    type(el, 'reset-password', 'nova-senha-segura');
    type(el, 'reset-confirmation', 'nova-senha-segura');
    await submit(fixture, el);
    expect(el.querySelector('#reset-factor')).not.toBeNull();
    type(el, 'reset-factor', '654321');
    await submit(fixture, el);
    expect(api.resetPassword).toHaveBeenLastCalledWith(token, 'nova-senha-segura', '654321');
  });
});
