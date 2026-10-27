import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { networkProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { THEME_PREFERENCE_KEY } from '../../core/session/appearance.service';
import { SettingsPage } from './settings.page';

@Component({ template: '' })
class Blank {}

const OWNER = {
  id: '1',
  email: 'dono@exemplo.com',
  displayName: 'Dono da Casa',
  role: 'owner',
  displayNameConfirmed: true,
  permissions: [],
};
const GUEST = {
  id: '2',
  email: 'alice@exemplo.com',
  displayName: 'Alice',
  role: 'guest',
  displayNameConfirmed: true,
  permissions: ['module:tv', 'tv:control'],
};

describe('SettingsPage (a list of screens)', () => {
  const api = {
    refresh: vi.fn(),
    me: vi.fn(),
    // Rotas de administrador: a lista nunca as chama (os testes conferem).
    passkeys: vi.fn(),
    guests: vi.fn(),
    guestInvites: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    for (const fn of Object.values(api)) fn.mockReset();
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockResolvedValue(OWNER);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'entrar', children: [] }]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const headings = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('h2')).map((h) => h.textContent?.trim());
  const rows = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLAnchorElement>('a.ui-row')).map((a) => ({
      title: a.querySelector('.ui-row-title')?.textContent?.trim(),
      summary: a.querySelector('.ui-row-sub')?.textContent?.trim(),
      href: a.getAttribute('href'),
    }));

  describe('for the administrator', () => {
    it('lists the screens in groups: personal, administration and the app', async () => {
      const { el } = await render();
      expect(headings(el)).toEqual(['Você', 'Administração', 'Aplicativo']);
    });

    it('has a row for each screen, with a short summary and where it goes', async () => {
      const { el } = await render();
      expect(rows(el)).toEqual([
        { title: 'Perfil', summary: 'Dono da Casa · Administrador', href: '/ajustes/perfil' },
        { title: 'Aparência', summary: 'Tema automático', href: '/ajustes/aparencia' },
        {
          title: 'Segurança',
          summary: 'Sessões de Acesso e passkeys',
          href: '/ajustes/seguranca',
        },
        {
          title: 'Pessoas e Permissões',
          summary: 'Convites e convidados',
          href: '/ajustes/pessoas',
        },
        {
          title: 'Dispositivos',
          summary: 'Agentes e computadores conectados',
          href: '/ajustes/dispositivos',
        },
        {
          title: 'Sistema',
          summary: 'Qual computador controla a TV',
          href: '/ajustes/sistema',
        },
        { title: 'Auditoria', summary: 'Quem fez o quê, e quando', href: '/ajustes/auditoria' },
        { title: 'Sobre', summary: 'Versão do app e da API', href: '/ajustes/sobre' },
      ]);
    });

    it('keeps the device row with a link name that starts with its title (what the other screens look for)', async () => {
      const { el } = await render();
      const link = el.querySelector<HTMLAnchorElement>('a[href="/ajustes/dispositivos"]');
      expect(link?.textContent?.trim().startsWith('Dispositivos')).toBe(true);
    });

    it('opens the real Auditoria screen: a link in the administration group, no longer a "coming soon" card', async () => {
      const { el } = await render();
      const link = el.querySelector<HTMLAnchorElement>('a[href="/ajustes/auditoria"]')!;
      expect(link.closest('section')?.querySelector('h2')?.textContent?.trim()).toBe(
        'Administração',
      );
      expect(link.textContent?.trim().startsWith('Auditoria')).toBe(true);
      expect(el.textContent).not.toContain('Em breve');
    });

    it('has a decorative icon and a chevron on each row, hidden from the screen reader', async () => {
      const { el } = await render();
      for (const link of Array.from(el.querySelectorAll('a.ui-row'))) {
        expect(
          link.querySelector('.ui-tile app-settings-glyph svg')?.getAttribute('aria-hidden'),
        ).toBe('true');
        expect(link.querySelector('.chev svg')?.getAttribute('aria-hidden')).toBe('true');
      }
    });

    it('the summary of Aparência follows the chosen theme', async () => {
      localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
      const { el } = await render();
      expect(rows(el)[1].summary).toBe('Tema escuro');
    });

    it('marks the row of the open screen with aria-current', async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'ajustes',
              children: [
                { path: '', pathMatch: 'full', component: SettingsPage },
                { path: 'perfil', component: SettingsPage },
              ],
            },
            { path: 'entrar', component: Blank },
          ]),
          { provide: AuthApi, useValue: api },
        ],
      });
      const harness = await RouterTestingHarness.create('/ajustes/perfil');
      const el = harness.routeNativeElement as HTMLElement;
      const current = Array.from(el.querySelectorAll('a[aria-current="page"]'));
      expect(current.map((a) => a.getAttribute('href'))).toEqual(['/ajustes/perfil']);
    });
  });

  describe('for a guest', () => {
    beforeEach(() => api.me.mockResolvedValue(GUEST));

    it('shows the personal area (with the connector download when the TV is allowed) and the app group', async () => {
      const { el } = await render();
      expect(headings(el)).toEqual(['Você', 'Aplicativo']);
      expect(rows(el)).toEqual([
        { title: 'Perfil', summary: 'Alice · Convidado', href: '/ajustes/perfil' },
        { title: 'Aparência', summary: 'Tema automático', href: '/ajustes/aparencia' },
        {
          title: 'Dispositivos',
          summary: 'Baixar o conector do PC',
          href: '/ajustes/dispositivos',
        },
        { title: 'Sobre', summary: 'Versão do app e da API', href: '/ajustes/sobre' },
      ]);
    });

    it('keeps the same groups for a guest without the TV, and without the connector row', async () => {
      api.me.mockResolvedValue({ ...GUEST, permissions: ['module:training'] });
      const { el } = await render();
      expect(rows(el).map((row) => row.title)).toEqual(['Perfil', 'Aparência', 'Sobre']);
      expect(headings(el)).toEqual(['Você', 'Aplicativo']);
      expect(el.querySelector('a[href="/tv"]')).toBeNull();
    });

    it('does not even mention the administrator screens', async () => {
      const { el } = await render();
      for (const name of ['Segurança', 'Pessoas e Permissões', 'Auditoria', 'Sistema']) {
        expect(el.textContent).not.toContain(name);
      }
      expect(el.querySelector('a[href="/ajustes/auditoria"]')).toBeNull();
    });
  });

  describe('while the role is unknown (session to confirm, no remembered role)', () => {
    it('shows only what is for everyone: the administrator rows wait for the role', async () => {
      api.refresh.mockRejectedValue(networkProblem());
      const { el } = await render();
      expect(rows(el).map((r) => r.title)).toEqual(['Perfil', 'Aparência', 'Sobre']);
    });
  });

  it.each([
    ['administrator', OWNER],
    ['guest', GUEST],
  ])('makes no request of its own as %s (the list is only links)', async (_role, me) => {
    api.me.mockResolvedValue(me);
    await render();
    expect(api.passkeys).not.toHaveBeenCalled();
    expect(api.guests).not.toHaveBeenCalled();
    expect(api.guestInvites).not.toHaveBeenCalled();
    expect(api.info).not.toHaveBeenCalled();
  });
});
