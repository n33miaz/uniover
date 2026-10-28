import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { INSTALL_ENV, InstallHintService } from '../../core/pwa/install-hint.service';
import { themePreferenceStorageKey } from '../../core/session/appearance.service';
import { AppearancePage } from './appearance.page';

const ME = { id: '1', email: 'dono@exemplo.com', displayName: 'Dono da Casa' };

describe('AppearancePage', () => {
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

  afterEach(() => localStorage.clear());

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(AppearancePage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  describe('theme', () => {
    it('offers automatic (default), light and dark', async () => {
      const { el } = await render();
      const options = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="theme"]'));
      expect(options.map((o) => o.value)).toEqual(['auto', 'light', 'dark']);
      expect(options.map((o) => o.checked)).toEqual([true, false, false]);
      expect(el.querySelector('#theme-title')?.textContent?.trim()).toBe('Tema');
      expect(el.querySelector('fieldset legend')?.textContent).toBe('Como o app aparece');
    });

    it('shows a sample of each theme, hidden from readers, next to a short label', async () => {
      const { el } = await render();
      const cards = Array.from(el.querySelectorAll('label.theme'));
      expect(cards.map((c) => c.querySelector('.theme-label')?.textContent?.trim())).toEqual([
        'Automático',
        'Claro',
        'Escuro',
      ]);
      for (const card of cards) {
        expect(card.querySelector('.preview')?.getAttribute('aria-hidden')).toBe('true');
      }
      expect(el.querySelector('fieldset .hint')?.textContent).toContain('Automático acompanha');
    });

    it('choosing dark saves the preference and applies the theme attribute', async () => {
      const { fixture, el } = await render();
      const dark = el.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!;
      dark.click();
      fixture.detectChanges();
      expect(localStorage.getItem(themePreferenceStorageKey(ME.id))).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(dark.checked).toBe(true);
    });
  });

  it('keeps module visibility out of Appearance, so it has one home for customization', async () => {
    const { el } = await render();
    expect(el.querySelector('#modules-title')).toBeNull();
    expect(el.querySelector('input[role="switch"]')).toBeNull();
  });

  describe('shortcut on the home screen', () => {
    const IPHONE =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

    it('has no row where there is nothing to offer (computer, or the app already installed)', async () => {
      const { el } = await render();
      expect(el.querySelector<HTMLElement>('app-install-hint-row')?.hidden).toBe(true);
    });

    it('has one row on an iPhone, right below the theme, that opens the shared sheet', async () => {
      TestBed.configureTestingModule({
        providers: [{ provide: INSTALL_ENV, useValue: { userAgent: IPHONE } }],
      });
      const { el } = await render();
      const row = el.querySelector<HTMLElement>('app-install-hint-row')!;
      expect(row.hidden).toBe(false);
      expect(row.previousElementSibling?.querySelector('fieldset.themes')).not.toBeNull();
      expect(row.querySelector('.ui-tile')).not.toBeNull();
      row.querySelector('button')!.click();
      expect(TestBed.inject(InstallHintService).sheet()).toBe('manual');
    });

    it('is there for the guest too (it belongs to the device, not to the role)', async () => {
      TestBed.configureTestingModule({
        providers: [{ provide: INSTALL_ENV, useValue: { userAgent: IPHONE } }],
      });
      api.me.mockResolvedValue({ ...ME, role: 'guest' });
      const { el } = await render();
      expect(el.querySelector<HTMLElement>('app-install-hint-row')?.hidden).toBe(false);
    });
  });
});
