import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { MODULE_PREFS_KEY, ModulePrefs } from '../../core/modules/module-prefs';
import { INSTALL_ENV, InstallHintService } from '../../core/pwa/install-hint.service';
import { THEME_PREFERENCE_KEY } from '../../core/session/appearance.service';
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
      expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(dark.checked).toBe(true);
    });
  });

  describe('modules on the home screen', () => {
    const rows = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('#modules-title ~ ul li')).map((li) => ({
        name: li.querySelector('.module-name')?.textContent?.trim(),
        chip: li.querySelector('.chip')?.textContent?.trim(),
        on: li.querySelector<HTMLInputElement>('input')?.checked,
      }));

    it('lists every module with its real or coming-soon chip and a switch', async () => {
      const { el } = await render();
      expect(rows(el)).toEqual([
        { name: 'TV', chip: 'Disponível', on: true },
        { name: 'Treino', chip: 'Disponível', on: true },
        { name: 'Saúde e eventos', chip: 'Em breve', on: true },
        { name: 'Monitor dos serviços', chip: 'Em breve', on: true },
        { name: 'Rede da casa', chip: 'Em breve', on: true },
        { name: 'Backup de fotos', chip: 'Em breve', on: true },
        { name: 'Avisos', chip: 'Em breve', on: true },
        { name: 'Controle do PC', chip: 'Em breve', on: true },
      ]);
      expect(el.querySelector('input[role="switch"]')).not.toBeNull();
      expect(el.querySelector('label.module')?.getAttribute('for')).toBe('module-tv');
    });

    it('turning a module off saves the choice locally and takes it out of the home grid list', async () => {
      const { fixture, el } = await render();
      const tv = el.querySelector<HTMLInputElement>('#module-tv')!;
      tv.checked = false;
      tv.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(rows(el)[0].on).toBe(false);
      expect(JSON.parse(localStorage.getItem(MODULE_PREFS_KEY)!)).toContainEqual(
        expect.objectContaining({ id: 'tv', enabled: false }),
      );
      expect(
        TestBed.inject(ModulePrefs)
          .visible()
          .map((w) => w.definition.id),
      ).toEqual(['training', 'health', 'monitor', 'network', 'backup', 'notifications', 'pc']);
    });

    it('lets a planned module be turned off and on again from here', async () => {
      const { fixture, el } = await render();
      const toggle = (checked: boolean) => {
        const input = el.querySelector<HTMLInputElement>('#module-network')!;
        input.checked = checked;
        input.dispatchEvent(new Event('change'));
        fixture.detectChanges();
      };
      const visible = () =>
        TestBed.inject(ModulePrefs)
          .visible()
          .map((w) => w.definition.id);
      toggle(false);
      expect(visible()).not.toContain('network');
      toggle(true);
      expect(visible()).toContain('network');
    });

    it('is not shown to a guest, who has no home screen to arrange', async () => {
      api.me.mockResolvedValue({ ...ME, role: 'guest' });
      const { el } = await render();
      expect(el.querySelector('#modules-title')).toBeNull();
      expect(el.querySelector('input[role="switch"]')).toBeNull();
      // O tema continua valendo para todos.
      expect(el.querySelectorAll('input[name="theme"]')).toHaveLength(3);
    });
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
