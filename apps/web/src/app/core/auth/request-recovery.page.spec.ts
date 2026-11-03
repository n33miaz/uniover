import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from './auth-api';
import { RequestRecoveryPage } from './request-recovery.page';

describe('RequestRecoveryPage', () => {
  const api = { requestPasswordRecovery: vi.fn(), passwordRecoveryAvailability: vi.fn() };

  beforeEach(() => {
    api.requestPasswordRecovery.mockReset();
    api.passwordRecoveryAvailability.mockReset().mockResolvedValue({ enabled: true });
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthApi, useValue: api }],
    });
  });

  it('shows the same neutral result after a valid request', async () => {
    api.requestPasswordRecovery.mockResolvedValue(undefined);
    const fixture = TestBed.createComponent(RequestRecoveryPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector<HTMLInputElement>('#recovery-email')!;
    field.value = '  conta@exemplo.com  ';
    field.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.requestPasswordRecovery).toHaveBeenCalledWith('conta@exemplo.com');
    expect(el.textContent).toContain('Se este e-mail estiver cadastrado');
    expect(el.textContent).not.toContain('conta@exemplo.com');
  });

  it('does not offer an email request while delivery is disabled', async () => {
    api.passwordRecoveryAvailability.mockResolvedValue({ enabled: false });
    const fixture = TestBed.createComponent(RequestRecoveryPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('ainda não está disponível');
    expect(api.requestPasswordRecovery).not.toHaveBeenCalled();
  });
});
