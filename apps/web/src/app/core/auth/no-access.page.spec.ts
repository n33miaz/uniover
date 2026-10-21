import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';
import { NoAccessPage } from './no-access.page';

describe('NoAccessPage', () => {
  const logout = vi.fn().mockResolvedValue(true);

  function render() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { logout } }],
    });
    const fixture = TestBed.createComponent(NoAccessPage);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => logout.mockClear());

  it('says in plain words that nothing is available yet, and that who invited can fix it', () => {
    const el = render();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Nada liberado por enquanto');
    expect(el.textContent).toContain('Peça a quem convidou você para liberar');
  });

  it('offers only the two ways out: the profile and signing out', () => {
    const el = render();
    const controls = Array.from(el.querySelectorAll('a, button'));
    expect(controls.map((control) => control.textContent?.trim())).toEqual([
      'Ver meu perfil',
      'Sair',
    ]);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/ajustes/perfil');
  });

  it('signs out', async () => {
    const el = render();
    el.querySelector<HTMLButtonElement>('button')!.click();
    expect(logout).toHaveBeenCalledOnce();
  });
});
