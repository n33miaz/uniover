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

  it('lists the sections: account, modules, appearance, home, security, guests and about', async () => {
    const { el } = await render();
    expect(headings(el)).toEqual([
      'Conta',
      'Módulos',
      'Aparência',
      'Casa',
      'Segurança',
      'Convidados',
      'Sobre',
    ]);
  });

  it('links to the devices screen, with the link name starting with its title', async () => {
    const { el } = await render();
    const link = el.querySelector<HTMLAnchorElement>('a[href="/ajustes/aparelhos"]');
    expect(link?.textContent?.trim().startsWith('Aparelhos')).toBe(true);
    expect(link?.closest('section')?.querySelector('h2')?.textContent?.trim()).toBe('Casa');
  });

  it('shows the account and signs out', async () => {
    const { fixture, el } = await render();
    expect(el.querySelector('.profile dl')?.textContent).toContain('Dono da Casa');
    expect(el.querySelector('.profile dl')?.textContent).toContain('dono@exemplo.com');
    expect(el.querySelector('.avatar')?.textContent?.trim()).toBe('D');
    expect(el.querySelector('.avatar')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toContain('Sessão ativa.');
    expect(el.querySelector('.session')?.classList.contains('ok')).toBe(true);

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
    // Sem alarme: tom de atenção, nunca o de erro.
    expect(el.querySelector('.session')?.classList.contains('warn')).toBe(true);
    expect(el.querySelector('.session')?.classList.contains('bad')).toBe(false);
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
  });

  describe('appearance', () => {
    it('offers automatic (default), light and dark', async () => {
      const { el } = await render();
      const options = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="theme"]'));
      expect(options.map((o) => o.value)).toEqual(['auto', 'light', 'dark']);
      expect(options.map((o) => o.checked)).toEqual([true, false, false]);
      expect(el.querySelector('fieldset legend')?.textContent).toBe('Tema');
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

    it('links the credits entry to the credits screen', async () => {
      const { el } = await render();
      const credits = Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).find((a) =>
        a.textContent?.trim().startsWith('Créditos'),
      );
      expect(credits?.getAttribute('href')).toBe('/ajustes/creditos');
      expect(
        el
          .querySelector('#about-title')
          ?.closest('section')
          ?.contains(credits ?? null),
      ).toBe(true);
    });
  });
});
