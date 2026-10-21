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
    it('lists the screens in groups: account, administration, soon and the app', async () => {
      const { el } = await render();
      expect(headings(el)).toEqual(['Conta', 'Administração', 'Em breve', 'Aplicativo']);
    });

    it('has a row for each screen, with a short summary and where it goes', async () => {
      const { el } = await render();
      expect(rows(el)).toEqual([
        { title: 'Perfil', summary: 'Dono da Casa · Administrador', href: '/ajustes/perfil' },
        { title: 'Aparência', summary: 'Tema automático', href: '/ajustes/aparencia' },
        {
          title: 'Segurança',
          summary: 'Passkeys que confirmam ações perigosas',
          href: '/ajustes/seguranca',
        },
        { title: 'Pessoas', summary: 'Convites e convidados', href: '/ajustes/pessoas' },
        {
          title: 'Aparelhos',
          summary: 'Parear o agente do PC de casa',
          href: '/ajustes/aparelhos',
        },
        { title: 'Sobre', summary: 'Versão do app e da API', href: '/ajustes/sobre' },
      ]);
    });

    it('keeps the device row with a link name that starts with its title (what the other screens look for)', async () => {
      const { el } = await render();
      const link = el.querySelector<HTMLAnchorElement>('a[href="/ajustes/aparelhos"]');
      expect(link?.textContent?.trim().startsWith('Aparelhos')).toBe(true);
    });

    it('shows Auditoria and Sistema as calm "Em breve" cards: no link, no button, no focus', async () => {
      const { el } = await render();
      const soon = el.querySelector('ul.soon')!;
      const cards = Array.from(soon.querySelectorAll('li'));
      expect(cards.map((c) => c.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
        'Auditoria',
        'Sistema',
      ]);
      for (const card of cards) {
        expect(card.querySelector('.ui-chip')?.textContent?.trim()).toBe('Em breve');
      }
      expect(soon.querySelectorAll('a, button, input, [tabindex], [role="link"]')).toHaveLength(0);
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

    it('shows only Perfil, Aparência and Sobre', async () => {
      const { el } = await render();
      expect(headings(el)).toEqual(['Conta', 'Aplicativo']);
      expect(rows(el)).toEqual([
        { title: 'Perfil', summary: 'Alice · Convidado', href: '/ajustes/perfil' },
        { title: 'Aparência', summary: 'Tema automático', href: '/ajustes/aparencia' },
        { title: 'Sobre', summary: 'Versão do app e da API', href: '/ajustes/sobre' },
      ]);
    });

    it('does not even mention the administrator screens, or the soon cards', async () => {
      const { el } = await render();
      for (const name of ['Segurança', 'Pessoas', 'Aparelhos', 'Auditoria', 'Sistema']) {
        expect(el.textContent).not.toContain(name);
      }
      expect(el.querySelector('ul.soon')).toBeNull();
      expect(el.querySelector('a[href="/ajustes/aparelhos"]')).toBeNull();
    });
  });

  describe('while the role is unknown (session to confirm, no remembered role)', () => {
    it('shows only what is for everyone: the administrator rows wait for the role', async () => {
      api.refresh.mockRejectedValue(networkProblem());
      const { el } = await render();
      expect(rows(el).map((r) => r.title)).toEqual(['Perfil', 'Aparência', 'Sobre']);
      expect(el.querySelector('ul.soon')).toBeNull();
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
