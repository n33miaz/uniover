import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { themePreferenceStorageKey } from '../../core/session/appearance.service';
import { ThemeSegment } from './theme-segment';

const ME = { id: '1', email: 'dono@exemplo.com', displayName: 'Dono da Casa' };

describe('ThemeSegment', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(ME);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthApi, useValue: api }],
    });
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(ThemeSegment);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const options = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]'));

  it('offers Claro, Escuro and Automático, in that order, with automatic selected by default', async () => {
    const { el } = await render();
    expect(
      Array.from(el.querySelectorAll('.option-label')).map((l) => l.textContent?.trim()),
    ).toEqual(['Claro', 'Escuro', 'Automático']);
    expect(options(el).map((o) => o.value)).toEqual(['light', 'dark', 'auto']);
    expect(options(el).map((o) => o.checked)).toEqual([false, false, true]);
  });

  it('is one named group of radio buttons, so a reader announces it as a choice', async () => {
    const { el } = await render();
    expect(el.querySelector('fieldset legend')?.textContent?.trim()).toBe('Tema');
    expect(new Set(options(el).map((o) => o.name)).size).toBe(1);
  });

  it('switches the theme at once and persists the choice for the account', async () => {
    const { fixture, el } = await render();
    options(el)[1].click();
    fixture.detectChanges();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(themePreferenceStorageKey('1'))).toBe('dark');
    expect(options(el).map((o) => o.checked)).toEqual([false, true, false]);

    options(el)[0].click();
    fixture.detectChanges();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(themePreferenceStorageKey('1'))).toBe('light');
  });

  it('shows the saved choice when it opens', async () => {
    localStorage.setItem(themePreferenceStorageKey('1'), 'dark');
    const { el } = await render();
    expect(options(el).map((o) => o.checked)).toEqual([false, true, false]);
  });
});
