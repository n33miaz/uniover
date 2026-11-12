import { TestBed } from '@angular/core/testing';
import { ApiProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { PasswordSection } from './password-section';

describe('PasswordSection', () => {
  const changePassword = vi.fn();
  const authorized = vi.fn((call: (token: string) => Promise<void>) => call('session-token'));

  beforeEach(() => {
    changePassword.mockReset().mockResolvedValue(undefined);
    authorized.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthApi, useValue: { changePassword } },
        { provide: AuthService, useValue: { authorized } },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(PasswordSection);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  function fill(root: HTMLElement, id: string, value: string) {
    const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function submit(root: HTMLElement) {
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  it('shows validation without sending the old password to an invalid request', async () => {
    const { fixture, root } = render();
    fill(root, 'current-password', 'old-password');
    fill(root, 'new-password', 'short');
    fill(root, 'confirm-password', 'wrong');
    submit(root);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('pelo menos 10 caracteres');
    expect(root.textContent).toContain('não coincidem');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('changes the password once and clears all secret fields', async () => {
    const { fixture, root } = render();
    fill(root, 'current-password', 'old-password');
    fill(root, 'new-password', 'new-password-123');
    fill(root, 'confirm-password', 'new-password-123');
    submit(root);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(changePassword).toHaveBeenCalledExactlyOnceWith(
      'session-token',
      'old-password',
      'new-password-123',
    );
    expect(root.textContent).toContain('outros acessos serão encerrados em até 10 minutos');
    for (const input of root.querySelectorAll<HTMLInputElement>('input'))
      expect(input.value).toBe('');
  });

  it('explains a wrong current password without clearing the fields', async () => {
    changePassword.mockRejectedValue(new ApiProblem(403, 'invalid-password', 'Senha incorreta'));
    const { fixture, root } = render();
    fill(root, 'current-password', 'old-password');
    fill(root, 'new-password', 'new-password-123');
    fill(root, 'confirm-password', 'new-password-123');
    submit(root);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'senha atual está incorreta',
    );
    expect(root.querySelector<HTMLInputElement>('#new-password')?.value).toBe('new-password-123');
  });
});
