import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { MODULE_PREFS_KEY, ModulePrefs } from '../../core/modules/module-prefs';
import { THEME_PREFERENCE_KEY } from '../../core/session/appearance.service';
import { version } from '../../../../package.json';
import { SettingsPage } from './settings.page';

const ME = { id: '1', email: 'dono@exemplo.com', displayName: 'Dono da Casa' };

describe('SettingsPage', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    info: vi.fn(),
    passkeys: vi.fn(),
    logout: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(ME);
    api.info.mockReset().mockResolvedValue({ module: 'identity', version: '1.2.3', dependsOn: [] });
    api.passkeys.mockReset().mockResolvedValue([]);
    api.logout.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'entrar', children: [] }]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const headings = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('h2')).map((h) => h.textContent?.trim());

  it('lists the sections: account, modules, appearance, security and about', async () => {
    const { el } = await render();
    expect(headings(el)).toEqual(['Conta', 'Módulos', 'Aparência', 'Segurança', 'Sobre']);
  });

  it('shows the account and signs out', async () => {
    const { fixture, el } = await render();
    expect(el.querySelector('#account-title + dl')?.textContent).toContain('Dono da Casa');
    expect(el.querySelector('#account-title + dl')?.textContent).toContain('dono@exemplo.com');
    expect(el.textContent).toContain('Sessão ativa.');

    el.querySelector<HTMLButtonElement>('section button.secondary')!.click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/entrar'));
    expect(api.logout).toHaveBeenCalledWith('t');
  });

  it('says the session is pending, without alarm, when the server cannot confirm it', async () => {
    api.refresh.mockRejectedValue(networkProblem());
    const { el } = await render();
    expect(el.querySelector('.session')?.textContent).toContain('Sessão a confirmar');
    expect(el.querySelector('.session')?.textContent).toContain('Nada foi apagado');
  });

  it('warns when sign-out could not reach the server', async () => {
    api.logout.mockRejectedValue(networkProblem());
    const { fixture, el } = await render();
    el.querySelector<HTMLButtonElement>('section button.secondary')!.click();
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/entrar'));
    fixture.detectChanges();
    expect(el.textContent).toContain('o servidor ainda não soube');
  });

  describe('modules', () => {
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
        { name: 'Treino', chip: 'Em breve', on: true },
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
      ).toEqual(['training']);
    });
  });

  describe('appearance', () => {
    it('offers automatic (default), light and dark', async () => {
      const { el } = await render();
      const options = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="theme"]'));
      expect(options.map((o) => o.value)).toEqual(['auto', 'light', 'dark']);
      expect(options.map((o) => o.checked)).toEqual([true, false, false]);
      expect(el.querySelector('fieldset legend')?.textContent).toBe('Tema');
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

  describe('about', () => {
    it('shows the app version from package.json and the API version', async () => {
      const { el } = await render();
      const about = el.querySelector('#about-title + dl')!.textContent!;
      expect(about).toContain('1.2.3');
      expect(about).toContain(version);
    });

    it('handles an API that does not answer', async () => {
      api.info.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
      const { el } = await render();
      expect(el.querySelector('#about-title + dl')!.textContent).toContain('indisponível agora');
    });

    it('keeps the credits entry disabled', async () => {
      const { el } = await render();
      const credits = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent?.trim() === 'Créditos',
      );
      expect(credits?.disabled).toBe(true);
    });
  });
});
